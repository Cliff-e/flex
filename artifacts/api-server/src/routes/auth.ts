/**
 * OAuth authentication routes — DigitalOcean backend.
 *
 * Implements a stateless server-side PKCE flow with HMAC-signed, expiring state:
 *   1. GET  /api/auth/login    — generate PKCE, build Deriv auth URL, redirect
 *   2. GET  /api/auth/callback — verify signed state, exchange code, redirect
 *                                to frontend with a one-time auth_code (never
 *                                the real access_token — see exchange below)
 *   3. POST /api/auth/exchange — redeem the one-time auth_code for the real
 *                                Deriv access_token (JSON body, not a URL)
 *   4. GET  /api/auth/accounts — proxy to Deriv accounts API
 *   5. POST /api/auth/otp      — proxy to Deriv OTP API
 *
 * Why the auth_code indirection: the Deriv access_token must ultimately live
 * in frontend JS (it authenticates the trading WebSocket directly against
 * Deriv, not through this backend), but it must never appear in a URL —
 * URLs land in browser history, server access logs, analytics, and Referer
 * headers. The callback redirect instead carries a short-lived, single-use,
 * random `auth_code` that is worthless outside the immediate exchange call.
 * The real token is only ever transmitted in a JSON response body.
 *
 * Environment variables required:
 *   VITE_DERIV_APP_ID  — Deriv app ID (registered in Deriv Developer Hub)
 *   SESSION_SECRET     — Secret used to HMAC-sign OAuth state (prevents login CSRF)
 *   API_BASE_URL       — This server's public URL  (e.g. https://your-api.ondigitalocean.app)
 *   FRONTEND_URL       — Frontend app URL           (e.g. https://your-app.ondigitalocean.app)
 */

import { Router } from "express";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { logger } from "../lib/logger";
import {
  asHandler,
  derivProxyRateLimiter,
  exchangeRateLimiter,
  loginRateLimiter,
} from "../middlewares/rateLimit";

const authRouter = Router();

// ---------------------------------------------------------------------------
// Config — sourced exclusively from environment variables
// ---------------------------------------------------------------------------

const IS_PRODUCTION = process.env.NODE_ENV === "production";

const APP_ID = process.env.VITE_DERIV_APP_ID ?? "";
/** Secret used to sign OAuth state and auth codes. Required — no insecure fallback. */
const SESSION_SECRET = process.env.SESSION_SECRET;
/** This server's own public URL. Used as OAuth redirect_uri registered with Deriv. */
const API_BASE_URL = process.env.API_BASE_URL ?? "";
/** Frontend app URL. After auth, backend redirects here with ?auth_code=. */
const FRONTEND_URL = process.env.FRONTEND_URL ?? "";

// Fail fast: refuse to start with an insecure/unsigned OAuth state secret.
if (!SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET must be set — it signs OAuth state and auth codes. Refusing to start with an insecure default.",
  );
}
/** Narrowed, definitely-set signing secret (the throw above guarantees this). */
const SIGNING_SECRET: string = SESSION_SECRET;

// Warn at startup in production but don't crash the process — the server
// must start so /healthz responds while env vars are being provisioned.
// Auth routes return 503 if vars are still absent when a request arrives.
if (IS_PRODUCTION) {
  const missing = [
    !APP_ID && "VITE_DERIV_APP_ID",
    !API_BASE_URL && "API_BASE_URL",
    !FRONTEND_URL && "FRONTEND_URL",
  ].filter(Boolean) as string[];
  if (missing.length > 0) {
    logger.warn(
      { missing },
      "Missing production environment variable(s) — auth routes will return 503 until they are set",
    );
  }
}

// Middleware applied to every auth route: rejects requests with 503 when
// required production env vars have not been supplied yet.
function requireAuthConfig(
  _req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  if (IS_PRODUCTION) {
    const missing = [
      !APP_ID && "VITE_DERIV_APP_ID",
      !API_BASE_URL && "API_BASE_URL",
      !FRONTEND_URL && "FRONTEND_URL",
    ].filter(Boolean) as string[];
    if (missing.length > 0) {
      res.status(503).json({
        error: "server_misconfigured",
        error_description: `Missing required environment variable(s): ${missing.join(", ")}`,
      });
      return;
    }
  }
  next();
}

authRouter.use(requireAuthConfig);

const DERIV_AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const DERIV_TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const DERIV_ACCOUNTS_URL =
  "https://api.derivws.com/trading/v1/options/accounts";
const DERIV_OTP_BASE = "https://api.derivws.com/trading/v1/options/accounts";

/** OAuth state expires after this many seconds (10 minutes). */
const STATE_TTL_SECONDS = 600;

// ---------------------------------------------------------------------------
// One-time auth code exchange (keeps the Deriv access_token off the URL)
//
// NOTE: this is an in-memory store, same constraint as the WS layer in
// src/index.ts — it only works correctly on a single instance. If this
// service is ever horizontally scaled, move it to a shared store (e.g.
// Redis) or ensure sticky routing between the /callback and /exchange calls.
// ---------------------------------------------------------------------------

/** Auth code is redeemed within seconds of being issued (one redirect + one fetch). */
const AUTH_CODE_TTL_MS = 60_000;
const authCodeStore = new Map<string, { accessToken: string; expiresAt: number }>();

function issueAuthCode(accessToken: string): string {
  const now = Date.now();
  // Opportunistic cleanup so the map doesn't grow unbounded with abandoned logins.
  for (const [code, entry] of authCodeStore) {
    if (entry.expiresAt <= now) authCodeStore.delete(code);
  }
  const code = randomBytes(32).toString("base64url");
  authCodeStore.set(code, { accessToken, expiresAt: now + AUTH_CODE_TTL_MS });
  return code;
}

/** Single-use: the code is deleted whether or not it was valid. */
function redeemAuthCode(code: string): string | null {
  const entry = authCodeStore.get(code);
  authCodeStore.delete(code);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.accessToken;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function generateVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ---------------------------------------------------------------------------
// HMAC-signed state helpers (prevents login CSRF / state substitution)
//
// State format: <base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>
// Payload: { verifier: string, iat: number (Unix seconds) }
//
// The HMAC binds the verifier to this server and makes the state tamper-evident.
// The `iat` field lets us enforce a TTL so stale states are rejected.
// ---------------------------------------------------------------------------

function signState(payload: Record<string, unknown>): string {
  const data = JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) });
  const encoded = Buffer.from(data).toString("base64url");
  const sig = createHmac("sha256", SIGNING_SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyState(state: string): Record<string, unknown> | null {
  const dotIdx = state.lastIndexOf(".");
  if (dotIdx < 0) return null;

  const encoded = state.slice(0, dotIdx);
  const sig = state.slice(dotIdx + 1);
  if (!encoded || !sig) return null;

  const expectedSig = createHmac("sha256", SIGNING_SECRET)
    .update(encoded)
    .digest("base64url");

  // Constant-time comparison to prevent timing attacks
  let sigMatch = false;
  try {
    sigMatch = timingSafeEqual(
      Buffer.from(sig, "base64url"),
      Buffer.from(expectedSig, "base64url")
    );
  } catch {
    return null; // buffers different lengths — tampering detected
  }
  if (!sigMatch) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    return null;
  }

  // Enforce TTL
  const iat = typeof payload.iat === "number" ? payload.iat : 0;
  if (Math.floor(Date.now() / 1000) - iat > STATE_TTL_SECONDS) {
    return null; // state has expired
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Shared config guard
// ---------------------------------------------------------------------------

function checkConfig(res: import("express").Response): boolean {
  if (!APP_ID) {
    res.status(500).json({ error: "server_config", error_description: "VITE_DERIV_APP_ID not set" });
    return false;
  }
  if (!API_BASE_URL) {
    res.status(500).json({ error: "server_config", error_description: "API_BASE_URL not set" });
    return false;
  }
  if (!FRONTEND_URL) {
    res.status(500).json({ error: "server_config", error_description: "FRONTEND_URL not set" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// GET /api/auth/login
// Generates PKCE challenge + HMAC-signed state, builds Deriv auth URL, redirects.
// ---------------------------------------------------------------------------

authRouter.get("/login", asHandler(loginRateLimiter), (req, res) => {
  if (!checkConfig(res)) return;

  const verifier = generateVerifier();
  const challenge = generateChallenge(verifier);

  // HMAC-sign the state — verifier stays server-side only
  const state = signState({ verifier });
  const callbackUri = `${API_BASE_URL}/api/auth/callback`;

  const params = new URLSearchParams({
    client_id: APP_ID,
    response_type: "code",
    redirect_uri: callbackUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  const authUrl = `${DERIV_AUTH_URL}?${params.toString()}`;
  logger.info("[auth/login] Redirecting to Deriv auth");
  res.redirect(authUrl);
});

// ---------------------------------------------------------------------------
// GET /api/auth/callback
// Receives ?code= from Deriv, verifies signed state, exchanges for token,
// redirects to frontend with ?access_token=.
// ---------------------------------------------------------------------------

authRouter.get("/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (!checkConfig(res)) return;

  if (error) {
    logger.error({ error }, "[auth/callback] Deriv OAuth error");
    const p = new URLSearchParams({
      error,
      error_description: error_description ?? error,
    });
    return res.redirect(`${FRONTEND_URL}/auth/callback?${p.toString()}`);
  }

  if (!code || !state) {
    const p = new URLSearchParams({
      error: "missing_params",
      error_description: "No authorization code or state received from Deriv",
    });
    return res.redirect(`${FRONTEND_URL}/auth/callback?${p.toString()}`);
  }

  // Verify HMAC-signed state and extract verifier
  const payload = verifyState(state);
  if (!payload) {
    logger.error("[auth/callback] Invalid or expired state — possible CSRF/replay");
    const p = new URLSearchParams({
      error: "invalid_state",
      error_description: "OAuth state is invalid or has expired. Please try logging in again.",
    });
    return res.redirect(`${FRONTEND_URL}/auth/callback?${p.toString()}`);
  }

  const verifier = typeof payload.verifier === "string" ? payload.verifier : "";
  if (!verifier) {
    const p = new URLSearchParams({
      error: "invalid_state",
      error_description: "OAuth state is missing the code verifier.",
    });
    return res.redirect(`${FRONTEND_URL}/auth/callback?${p.toString()}`);
  }

  const callbackUri = `${API_BASE_URL}/api/auth/callback`;

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: APP_ID,
      code,
      code_verifier: verifier,
      redirect_uri: callbackUri,
    });

    const upstream = await fetch(DERIV_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Deriv-App-ID": APP_ID,
      },
      body: body.toString(),
    });

    // Log status only — never log raw response body (may contain access_token)
    logger.info({ status: upstream.status }, "[auth/callback] Deriv token exchange status");

    if (!upstream.ok) {
      // Read error body for diagnostics but never log token-bearing success payloads
      const errText = await upstream.text().catch(() => "");
      // Scrub any token-like values from the error text before logging
      const safeErr = errText.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[REDACTED]"');
      logger.error(
        { status: upstream.status, body: safeErr.slice(0, 200) },
        "[auth/callback] Token exchange failed",
      );
      const p = new URLSearchParams({
        error: "token_exchange_failed",
        error_description: `Deriv returned ${upstream.status}`,
      });
      return res.redirect(`${FRONTEND_URL}/auth/callback?${p.toString()}`);
    }

    let data: Record<string, string>;
    try {
      data = (await upstream.json()) as Record<string, string>;
    } catch {
      logger.error("[auth/callback] Token response is not valid JSON");
      const p = new URLSearchParams({
        error: "upstream_non_json",
        error_description: "Token endpoint returned non-JSON response",
      });
      return res.redirect(`${FRONTEND_URL}/auth/callback?${p.toString()}`);
    }

    const accessToken = data.access_token;
    if (!accessToken) {
      logger.error("[auth/callback] Token exchange succeeded but response missing access_token");
      const p = new URLSearchParams({
        error: "no_access_token",
        error_description: "Token exchange succeeded but no access_token returned",
      });
      return res.redirect(`${FRONTEND_URL}/auth/callback?${p.toString()}`);
    }

    // Issue a short-lived, single-use auth_code instead of putting the real
    // access_token in the URL — the token is only ever handed back via the
    // JSON body of POST /api/auth/exchange (see below).
    const authCode = issueAuthCode(accessToken);
    const success = new URLSearchParams({ auth_code: authCode });
    logger.info("[auth/callback] Token exchange successful — redirecting to frontend with one-time auth code");
    return res.redirect(`${FRONTEND_URL}/auth/callback?${success.toString()}`);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "[auth/callback] Token exchange error");
    const p = new URLSearchParams({
      error: "server_error",
      error_description: "An internal error occurred during token exchange",
    });
    return res.redirect(`${FRONTEND_URL}/auth/callback?${p.toString()}`);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/exchange
// Redeems a one-time auth_code (issued by /callback) for the real Deriv
// access_token AND completes the full login:
//   1. Redeem the auth_code → access_token.
//   2. Fetch the user's Deriv accounts server-side (avoids scope issues from
//      a browser-originated request and keeps the token off the URL).
//   3. Determine the primary login ID and currency.
//   4. Return the complete session in one response — the frontend does not
//      need to make any further authenticated requests to bootstrap the session.
//
// Response shape:
//   { access_token, primary_loginid, primary_currency, accounts[] }
//
// If the accounts fetch fails (transient upstream error) we still return the
// token with empty account fields so the frontend can fall back to WS authorize().
// ---------------------------------------------------------------------------

authRouter.post("/exchange", asHandler(exchangeRateLimiter), async (req, res) => {
  const { code } = req.body as { code?: unknown };
  if (typeof code !== "string" || !code) {
    return res.status(400).json({
      error: "missing_params",
      error_description: "code is required",
    });
  }

  const accessToken = redeemAuthCode(code);
  if (!accessToken) {
    return res.status(400).json({
      error: "invalid_or_expired_code",
      error_description: "Auth code is invalid, already used, or expired. Please log in again.",
    });
  }

  logger.info("[auth/exchange] Auth code redeemed — fetching accounts server-side");

  // Fetch accounts server-to-server so the browser never needs to call
  // /api/auth/accounts separately (which was returning 403 Insufficient scopes).
  type RawAccount = Record<string, unknown>;
  let accounts: RawAccount[] = [];
  let primaryLoginid = "";
  let primaryCurrency = "";

  try {
    const accountsRes = await fetch(DERIV_ACCOUNTS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Deriv-App-ID": APP_ID,
      },
    });

    logger.info({ status: accountsRes.status }, "[auth/exchange] Deriv accounts status");

    if (accountsRes.ok) {
      const accountsData = (await accountsRes.json().catch(() => null)) as Record<string, unknown> | null;
      if (accountsData) {
        const rawList: RawAccount[] =
          (accountsData?.data as RawAccount[] | undefined) ??
          (accountsData?.accounts as RawAccount[] | undefined) ??
          (Array.isArray(accountsData) ? (accountsData as RawAccount[]) : []);

        accounts = rawList;

        // Real accounts before virtual/demo — the first one becomes primary.
        const sorted = [...rawList].sort((a: RawAccount) => {
          const t = String(a.account_type ?? a.type ?? "").toLowerCase();
          return t === "demo" || t === "virtual" ? 1 : -1;
        });

        for (const acct of sorted) {
          const id = String(acct.account_id ?? acct.id ?? acct.loginid ?? "");
          const cur = String(acct.currency ?? acct.account_currency ?? "");
          if (!id) continue;
          if (!primaryLoginid) {
            primaryLoginid = id;
            primaryCurrency = cur;
          }
        }
      }
    } else {
      const errText = await accountsRes.text().catch(() => "");
      logger.warn(
        { status: accountsRes.status, body: errText.slice(0, 200) },
        "[auth/exchange] Accounts fetch non-OK — returning token without account data",
      );
    }
  } catch (acctErr) {
    logger.warn(
      { err: (acctErr as Error).message },
      "[auth/exchange] Accounts fetch error — returning token without account data",
    );
  }

  logger.info(
    { primaryLoginid: primaryLoginid || "(none)", accountCount: accounts.length },
    "[auth/exchange] Session complete",
  );

  return res.status(200).json({
    access_token: accessToken,
    primary_loginid: primaryLoginid,
    primary_currency: primaryCurrency,
    accounts,
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/accounts
// Proxies to Deriv accounts API. Requires Authorization: Bearer <token>.
// ---------------------------------------------------------------------------

authRouter.get("/accounts", asHandler(derivProxyRateLimiter), async (req, res) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "missing_token",
      error_description: "Authorization: Bearer <token> required",
    });
  }

  try {
    const upstream = await fetch(DERIV_ACCOUNTS_URL, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        "Deriv-App-ID": APP_ID,
      },
    });

    logger.info({ status: upstream.status }, "[auth/accounts] Deriv response status");

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      return res.status(upstream.status).json({
        error: "upstream_error",
        error_description: errText.slice(0, 200),
      });
    }

    let data: unknown;
    try {
      data = await upstream.json();
    } catch {
      return res.status(502).json({
        error: "upstream_non_json",
        error_description: "Accounts endpoint returned non-JSON response",
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "[auth/accounts] upstream error");
    return res.status(502).json({ error: "upstream_error", error_description: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/otp
// Generates an OTP token for authenticated WebSocket connections.
// ---------------------------------------------------------------------------

authRouter.post("/otp", asHandler(derivProxyRateLimiter), async (req, res) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "missing_token",
      error_description: "Authorization: Bearer <token> required",
    });
  }

  const { account_id } = req.body as { account_id?: string };
  if (!account_id) {
    return res.status(400).json({
      error: "missing_params",
      error_description: "account_id is required",
    });
  }

  try {
    const upstream = await fetch(`${DERIV_OTP_BASE}/${account_id}/otp`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Deriv-App-ID": APP_ID,
        "Content-Type": "application/json",
      },
    });

    logger.info({ status: upstream.status }, "[auth/otp] Deriv response status");

    let data: unknown;
    try {
      data = await upstream.json();
    } catch {
      return res.status(502).json({
        error: "upstream_non_json",
        error_description: "OTP endpoint returned non-JSON response",
      });
    }

    return res.status(upstream.status).json(data);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "[auth/otp] upstream error");
    return res.status(502).json({ error: "upstream_error", error_description: String(err) });
  }
});

export default authRouter;
