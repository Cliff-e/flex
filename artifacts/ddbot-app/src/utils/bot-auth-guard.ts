/**
 * bot-auth-guard.ts
 *
 * Centralised auth gate for ALL AI bot / trading engine actions.
 *
 * RULE: Every bot action that requires live trading MUST call
 * requireCanonicalAuthOrPause() before proceeding.
 *
 * If auth is not ready the function throws — callers must catch and surface
 * the error to the user instead of silently continuing with stale state.
 */
import { AuthSessionManager, type CanonicalAuthState } from './AuthSessionManager';

export class BotAuthNotReadyError extends Error {
    readonly code = 'BOT_PAUSED';
    constructor(reason: string) {
        super(`BOT_PAUSED: ${reason}`);
        this.name = 'BotAuthNotReadyError';
    }
}

/**
 * Returns the canonical auth state when authentication + WS authorization are
 * both confirmed.  Throws BotAuthNotReadyError otherwise.
 *
 * Usage:
 *   const auth = requireCanonicalAuthOrPause();
 *   // safe to use auth.accountId, auth.accessToken, auth.isAuthorized
 *
 * The bot MUST NOT fall back to localStorage on failure — it must pause and
 * wait for the next AuthSessionManager.onAuthChange() callback.
 */
export function requireCanonicalAuthOrPause(): CanonicalAuthState {
    const auth = AuthSessionManager.getCanonicalAuthState();

    if (!auth.isAuthenticated) {
        throw new BotAuthNotReadyError(
            'No credentials in session — user must be logged in to run the bot'
        );
    }

    if (!auth.isAuthorized) {
        throw new BotAuthNotReadyError(
            'WebSocket session is not yet authorized — wait for auth:success before running the bot'
        );
    }

    return auth;
}

/**
 * Non-throwing variant — returns null when auth is not ready instead of
 * throwing.  Use for soft checks (e.g. disabling a button) where you do not
 * want to interrupt execution flow.
 */
export function getCanonicalAuthOrNull(): CanonicalAuthState | null {
    try {
        return requireCanonicalAuthOrPause();
    } catch {
        return null;
    }
}
