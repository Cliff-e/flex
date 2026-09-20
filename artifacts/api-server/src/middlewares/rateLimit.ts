/**
 * Rate limiters for authentication-related routes.
 *
 * Deriv OAuth endpoints are the most sensitive/expensive routes in this
 * service (they call out to Deriv's OAuth/accounts/OTP APIs on our
 * server's behalf), so they get tighter limits than a general API route
 * would. Limits are generous enough that a real user retrying a failed
 * login a few times never gets blocked, but tight enough to blunt
 * scripted abuse.
 *
 * Keyed by `req.ip`, which requires Express's `trust proxy` setting to be
 * configured correctly behind DigitalOcean App Platform's load balancer
 * (see app.ts) — otherwise every request would appear to come from the
 * same internal LB IP and the limiter would be ineffective.
 */

import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { RequestHandler } from "express";

/**
 * Cast a RateLimitRequestHandler to Express's RequestHandler.
 *
 * express-rate-limit's types were authored against @types/express-serve-static-core@4;
 * this project uses Express 5 (@types/express-serve-static-core@5). The two
 * versions of the core types are structurally incompatible at the `req.param`
 * method, which was removed in Express 5. At runtime the middleware is
 * identical — the cast is purely a compile-time annotation bridge.
 */
export function asHandler(fn: RateLimitRequestHandler): RequestHandler {
  return fn as unknown as RequestHandler;
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/** GET /api/auth/login — redirects to Deriv, one per real login attempt. */
export const loginRateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", error_description: "Too many login attempts. Please try again later." },
});

/** POST /api/auth/exchange — redeems a one-time auth_code for a token. */
export const exchangeRateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", error_description: "Too many exchange attempts. Please try again later." },
});

/** POST /api/auth/otp and GET /api/auth/accounts — authenticated Deriv proxy calls. */
export const derivProxyRateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", error_description: "Too many requests. Please try again later." },
});

/**
 * POST /api/vps-bots/upload — receipt of a strategy document.
 *
 * Uploads are cheap for us but each one allocates a bot slot on a host that
 * supports three, so the limit is deliberately low. It is a ceiling on accidents
 * and scripted abuse, not a quota a real user can hit: a person uploads a
 * strategy when they have written one.
 */
export const vpsBotUploadRateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", error_description: "Too many uploads. Please try again later." },
});

/**
 * VPS bot process control (deploy/start/stop/restart/delete) and reads.
 *
 * Each control call shells out to PM2 and each read touches the filesystem, so
 * these are the most expensive routes in the service after the Deriv proxies.
 * The limit is per IP, not per user, because this backend has no session store.
 */
export const vpsBotControlRateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", error_description: "Too many bot operations. Please try again later." },
});
