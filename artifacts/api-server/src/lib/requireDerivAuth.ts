/**
 * Authentication middleware for VPS bot management.
 *
 * WHY IT LOOKS LIKE THIS
 * ---------------------
 * This backend is stateless: `/api/auth/exchange` hands the browser a Deriv
 * access token and keeps nothing. The established pattern for "this request came
 * from a logged-in user" in this service is therefore the token itself, which the
 * browser already sends as `Authorization: Bearer …` to `/api/auth/accounts` and
 * `/api/auth/otp`.
 *
 * This middleware applies the same idea with one addition: the token is VERIFIED
 * against Deriv's accounts API before the request is allowed through, so a forged
 * or expired header cannot reach process control. A request is never trusted
 * merely because it carries an unchecked string.
 *
 * The verified context (token + accounts) is stored in `res.locals` - it is not
 * echoed back, not logged, and not returned to the client.
 */

import type { Request, RequestHandler, Response } from "express";
import { logger } from "./logger";

/** Deriv app id, using the same env var name as routes/auth.ts. */
const APP_ID = process.env["VITE_DERIV_APP_ID"] ?? "";

/** Deriv accounts endpoint - the same one routes/auth.ts proxies. */
const DERIV_ACCOUNTS_URL =
  process.env["DERIV_ACCOUNTS_URL"] ?? "https://api.derivws.com/trading/v1/options/accounts";

const VERIFY_TIMEOUT_MS = 15_000;

export type DerivAccount = { loginid: string; currency: string };

export type DerivAuthContext = {
  /** Deriv access token. Lives only in memory for the life of the request. */
  accessToken: string;
  /** Primary login id, when Deriv reports one. */
  accountId: string | null;
  currency: string | null;
  accounts: DerivAccount[];
};

export type DerivAuthResult =
  | { ok: true; context: DerivAuthContext }
  | { ok: false; status: number; code: string; message: string };

export type DerivTokenVerifier = (accessToken: string) => Promise<DerivAuthResult>;

const LOCALS_KEY = "derivAuth";

/** Reads the verified context, or null when the route was not protected. */
export function getDerivAuth(res: Response): DerivAuthContext | null {
  const value = (res.locals as Record<string, unknown>)[LOCALS_KEY];
  return value && typeof value === "object" ? (value as DerivAuthContext) : null;
}

/** Extracts a plausible bearer token. The value is never logged. */
export function extractBearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  // An Ory access token is long and contains no whitespace.
  if (token.length < 20 || /\s/.test(token)) return null;
  return token;
}

/** Extracts `{ loginid, currency }` pairs from the Deriv accounts payload. */
export function parseAccounts(payload: unknown): DerivAccount[] {
  const list = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return [];

  const accounts: DerivAccount[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const loginid = record["account_id"] ?? record["loginid"];
    const currency = record["currency"];
    if (typeof loginid === "string" && loginid !== "") {
      accounts.push({ loginid, currency: typeof currency === "string" ? currency : "" });
    }
  }
  return accounts;
}

/**
 * Verifies an access token by asking Deriv which accounts it can see.
 *
 * A 401/403 from Deriv means the credential is dead → the caller gets 401 and
 * the UI is expected to offer re-authentication. A network failure is NOT
 * reported as an authentication failure: that would log the user out because
 * Deriv had a bad minute.
 */
export const verifyDerivAccessToken: DerivTokenVerifier = async (accessToken) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(DERIV_ACCOUNTS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Deriv-App-ID": APP_ID,
      },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: 401,
        code: "invalid_token",
        message: "Deriv rejected this session. Please sign in again.",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: 502,
        code: "upstream_error",
        message: `Deriv accounts API returned ${response.status}`,
      };
    }

    const payload: unknown = await response.json().catch(() => null);
    const accounts = parseAccounts(payload);
    if (accounts.length === 0) {
      return {
        ok: false,
        status: 401,
        code: "no_accounts",
        message: "Deriv returned no accounts for this session. Please sign in again.",
      };
    }

    const primary = accounts[0];
    return {
      ok: true,
      context: {
        accessToken,
        accountId: primary ? primary.loginid : null,
        currency: primary ? primary.currency : null,
        accounts,
      },
    };
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : "unknown" },
      "[vps-bots] token verification failed",
    );
    return {
      ok: false,
      status: 503,
      code: "verification_unavailable",
      message: "Could not verify the session with Deriv. Please try again.",
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Builds the middleware.
 *
 * The verifier is injectable so the Phase 2 gate can exercise every
 * authentication branch over real HTTP without calling Deriv.
 */
export function createRequireDerivAuth(verify: DerivTokenVerifier = verifyDerivAccessToken): RequestHandler {
  return (req: Request, res: Response, next): void => {
    const token = extractBearerToken(req.headers["authorization"]);
    if (!token) {
      res.status(401).json({ error: "missing_token", error_description: "Sign in to manage VPS bots." });
      return;
    }

    void verify(token).then((result) => {
      if (!result.ok) {
        res.status(result.status).json({ error: result.code, error_description: result.message });
        return;
      }
      (res.locals as Record<string, unknown>)[LOCALS_KEY] = result.context;
      next();
    });
  };
}

/** Default middleware instance used by the router. */
export const requireDerivAuth: RequestHandler = createRequireDerivAuth();
