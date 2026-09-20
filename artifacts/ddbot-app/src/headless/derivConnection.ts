/**
 * Headless Deriv connection adapter for the VPS bot runtime.
 *
 * WHAT IT REUSES (and deliberately does not re-implement)
 * -------------------------------------------------------
 * The browser already contains a complete, working authenticated-transport
 * stack. This adapter drives it unchanged:
 *
 *   AuthSessionManager  - owns the access token + loginid in storage
 *   AccountModeController - gates the authenticated (OTP) connection mode
 *   WebSocketManager    - the ONE authenticated DerivAPIBasic socket
 *   api_base            - the trading API facade the trade engine calls into
 *
 * There is no second WebSocket client, no second Deriv auth flow and no
 * reimplementation of the trade engine's transport. `api_base.init()` performs
 * the exact sequence the browser performs at startup (connect, authorize,
 * active symbols, subscriptions); we only observe the outcome and translate it
 * into a runtime state.
 *
 * AUTHENTICATION RENEWAL - WHAT IS ACTUALLY SUPPORTED
 * --------------------------------------------------
 * Verified against the current implementation before writing this file:
 *
 *   1. `/api/auth/login` requests scope `trade account_manage`. It does NOT
 *      request `offline_access`, and `/api/auth/callback` reads only
 *      `access_token` from the token response - no refresh token is present in,
 *      or handled by, this codebase. `offline_access` is therefore NOT added
 *      here.
 *   2. The access token Deriv issues is an Ory token (`ory_at_…`). The existing
 *      guard in `AuthSessionManager.getAuthInfo()` documents the behaviour
 *      explicitly: Ory tokens are account-scoped and are rejected by Deriv on
 *      the public WebSocket, so they may ONLY be used through an OTP WebSocket
 *      URL (`POST /accounts/{id}/otp`).
 *   3. Consequently the renewal mechanism this runtime uses is the one the
 *      application already uses (`AuthManager`): throw away the cached OTP
 *      credential, mint a fresh one from the still-valid access token and
 *      reconnect. The OTP credential is the short-lived artifact (~30 min); the
 *      access token is the longer-lived one.
 *   4. When the access token itself is refused by Deriv, renewal is impossible
 *      without the user completing the OAuth flow again. The runtime then
 *      transitions to `expired` so the UI can offer `[Re-authenticate]`.
 *      Re-authentication is performed by the existing OAuth flow; the backend
 *      then writes the new token to the bot's credential file and the runtime
 *      picks it up via `updateCredentials()` on the next renewal attempt.
 *
 * Nothing in this file logs a token, an OTP value or an OTP URL.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AccountModeController } from '../utils/AccountModeController';
import { AuthSessionManager } from '../utils/AuthSessionManager';
import { EventBus } from '../utils/EventBus';
import { api_base } from '../external/bot-skeleton/services/api/api-base';
import { maskCredential, safeErrorText, secrets } from './redact';
import type { BotState } from './stats';

/** Deriv app id registered in the Deriv Developer Hub. Public, not a secret. */
export const DEFAULT_DERIV_APP_ID = '33gBzpTA0Py8ehX45PBxR';

/** Public (unauthenticated) Deriv trading WebSocket - same URL the app uses. */
export const DEFAULT_DERIV_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

/** Deriv error codes that mean "the credential is no longer usable". */
const EXPIRED_AUTH_CODES = new Set([
    'InvalidToken',
    'AuthorizationRequired',
    'PleaseAuthenticate',
    'InputValidationFailed',
    'ClientUnwelcome',
    'AuthenticationRequired',
]);

/** Substrings that mark an upstream authentication refusal rather than a fault. */
const EXPIRED_AUTH_HINTS = /unauthor|invalid token|invalid_token|otp request failed|not authenticated|401|403/i;


/** Credentials a bot needs to mint an authenticated Deriv connection. */
export type DerivCredentials = {
    accountId: string;
    /** Deriv access token. Never logged, never persisted by this module. */
    accessToken: string;
    appId: string;
    /** Account currency from the credential source; the generator embeds it. */
    currency?: string;
    /** How the credentials were obtained - for diagnostics only. */
    source: 'env' | 'file';
};

export type CredentialLoadResult =
    | { ok: true; credentials: DerivCredentials }
    | { ok: false; reason: string };

/** Deriv login ids are alphanumeric with an optional hyphen (e.g. `VRTC1234567`). */
const LOGINID_PATTERN = /^[A-Za-z0-9-]{3,24}$/;

/** Ory access tokens are long; anything shorter is a typo or a placeholder. */
const MIN_TOKEN_LENGTH = 20;

function isValidLoginid(value: unknown): value is string {
    return typeof value === 'string' && LOGINID_PATTERN.test(value);
}

function isValidAccessToken(value: unknown): value is string {
    return typeof value === 'string' && value.length >= MIN_TOKEN_LENGTH && !/\s/.test(value);
}

/**
 * Loads a bot's Deriv credentials.
 *
 * Sources, in priority order:
 *   1. `BOT_ACCOUNT_ID` + `BOT_ACCESS_TOKEN` environment variables (one-off runs
 *      and tests),
 *   2. a JSON file - `<bot-dir>/credentials.json` by default - written by the
 *      backend after a successful OAuth exchange. The file is the production
 *      path because the token must outlive a browser session.
 *
 * The credentials are validated here so a malformed file surfaces as a clear
 * `expired` state instead of an opaque WebSocket failure. The token value is
 * registered with the redaction registry the moment it is read.
 */
export function loadCredentials(options: {
    credentialFile?: string;
    appId?: string;
    env?: NodeJS.ProcessEnv;
} = {}): CredentialLoadResult {
    const env = options.env ?? process.env;
    const appId = options.appId ?? env.DERIV_APP_ID ?? DEFAULT_DERIV_APP_ID;

    const envAccountId = env.BOT_ACCOUNT_ID;
    const envAccessToken = env.BOT_ACCESS_TOKEN;

    if (envAccountId || envAccessToken) {
        if (!isValidLoginid(envAccountId)) {
            return { ok: false, reason: 'BOT_ACCOUNT_ID is missing or not a valid Deriv login id' };
        }
        if (!isValidAccessToken(envAccessToken)) {
            return { ok: false, reason: 'BOT_ACCESS_TOKEN is missing or too short to be an access token' };
        }
        const credentials: DerivCredentials = {
            accountId: envAccountId,
            accessToken: envAccessToken,
            appId,
            currency: env.BOT_ACCOUNT_CURRENCY,
            source: 'env',
        };
        secrets.register(credentials.accessToken);
        return { ok: true, credentials };
    }

    const file = options.credentialFile;
    if (!file) return { ok: false, reason: 'no credential source configured (BOT_CREDENTIAL_FILE or BOT_ACCESS_TOKEN)' };
    if (!existsSync(file)) return { ok: false, reason: `credential file not found (${file})` };

    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
        return { ok: false, reason: 'credential file is not valid JSON' };
    }

    // Accept both snake_case (what the backend writes) and camelCase.
    const accountId = raw.account_id ?? raw.accountId;
    const accessToken = raw.access_token ?? raw.accessToken;
    const currency = raw.currency;

    if (!isValidLoginid(accountId)) return { ok: false, reason: 'credential file has no valid account_id' };
    if (!isValidAccessToken(accessToken)) return { ok: false, reason: 'credential file has no usable access_token' };

    const credentials: DerivCredentials = {
        accountId,
        accessToken,
        appId,
        currency: typeof currency === 'string' && currency ? currency : undefined,
        source: 'file',
    };
    secrets.register(credentials.accessToken);
    return { ok: true, credentials };
}

/**
 * A stable, non-reversible fingerprint of a credential pair.
 *
 * Used to answer "did the backend hand us a NEW token?" without ever comparing
 * or logging the token itself.
 */
export function credentialFingerprint(credentials: Pick<DerivCredentials, 'accountId' | 'accessToken'>): string {
    return createHash('sha256').update(`${credentials.accountId}:${credentials.accessToken}`).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------
//
// Every collaborator is a narrow interface with a real implementation obtained
// from `realDeps()`. Tests substitute fakes, so the state machine can be verified
// without touching the network, and no module is monkey-patched.

export type AuthSessionLike = {
    setActiveAccount: (loginid: string, token: string) => void;
    invalidateOtpCache: () => void;
    isAuthenticated: () => boolean;
};

export type AccountModeLike = {
    enableAccountMode: () => void;
};

export type ApiBaseLike = {
    init: (forceCreateConnection?: boolean) => Promise<void>;
    terminate: () => void;
    is_authorized: boolean;
    account_id: string;
    token: string;
    /** Present once the trade engine has resolved the account. */
    account_info?: { loginid?: string; currency?: string } | undefined;
};

export type AuthFailure = { code?: string; message?: string; [key: string]: unknown };

export type EventBusLike = {
    on: (event: 'auth:failed', handler: (payload: AuthFailure) => void) => () => void;
};

export type DerivConnectionDeps = {
    authSession: AuthSessionLike;
    accountMode: AccountModeLike;
    apiBase: ApiBaseLike;
    eventBus: EventBusLike;
};

/**
 * Real collaborators.
 *
 * The casts are unavoidable and intentional: the real modules are richer than
 * the narrow interfaces above (the event bus is typed per-event, `api_base` is a
 * class instance). The interfaces describe exactly what this adapter is allowed
 * to touch, so an accidental dependency on anything else fails typecheck.
 */
export function realDeps(): DerivConnectionDeps {
    return {
        authSession: AuthSessionManager as unknown as AuthSessionLike,
        accountMode: AccountModeController as unknown as AccountModeLike,
        apiBase: api_base as unknown as ApiBaseLike,
        eventBus: EventBus as unknown as EventBusLike,
    };
}

/** Rejects after `ms` so an in-flight connect can never block shutdown forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        if (typeof timer.unref === 'function') timer.unref();
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}


// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type ConnectOptions = {
    /** Bounded so a stalled handshake can never block shutdown indefinitely. */
    timeoutMs?: number;
};

/**
 * Owns one bot's Deriv authentication lifecycle.
 *
 * State machine (the single vocabulary shared by `stats.json` and the UI):
 *
 *   starting ──▶ authenticated      (Deriv accepted the credential)
 *      │  │
 *      │  ├──▶ expired              (credential refused / no authorization -
 *      │  │                          only the user can fix this)
 *      │  └──▶ error                (transport or unexpected failure)
 *      ▼
 *   stopping ──▶ stopped
 */
export class DerivConnection {
    private _credentials: DerivCredentials;
    private readonly _deps: DerivConnectionDeps;
    private _fingerprint: string;

    private _state: BotState = 'starting';
    private _closed = false;
    private _lastFailure: AuthFailure | null = null;
    private _lastError: string | null = null;

    private readonly _unsubscribes: Array<() => void> = [];
    private _listeners: Array<(state: BotState, detail: string) => void> = [];

    constructor(credentials: DerivCredentials, deps: DerivConnectionDeps = realDeps()) {
        this._credentials = credentials;
        this._deps = deps;
        this._fingerprint = credentialFingerprint(credentials);
        secrets.register(credentials.accessToken);
    }

    get state(): BotState {
        return this._state;
    }

    /** Non-reversible credential fingerprint - safe to log and to compare. */
    get fingerprint(): string {
        return this._fingerprint;
    }

    /** The Deriv login id (e.g. `VRTC1234567`). Not a secret. */
    get accountId(): string {
        return this._credentials.accountId;
    }

    /** Last redacted failure text, or null. Never contains a credential. */
    get lastError(): string | null {
        return this._lastError;
    }

    /** True once Deriv has authorized the WebSocket. */
    get isAuthenticated(): boolean {
        return this._state === 'authenticated';
    }

    onStateChange(listener: (state: BotState, detail: string) => void): () => void {
        this._listeners.push(listener);
        return () => {
            this._listeners = this._listeners.filter(entry => entry !== listener);
        };
    }

    /**
     * Replaces the credentials after a server-side re-authentication.
     *
     * Returns true when the credentials actually changed. The new token is
     * registered with the redaction registry *before* the old one is forgotten,
     * so a token is never unprotected during rotation.
     */
    updateCredentials(credentials: DerivCredentials): boolean {
        const next = credentialFingerprint(credentials);
        if (next === this._fingerprint) return false;

        secrets.register(credentials.accessToken);
        secrets.forget(this._credentials.accessToken);
        this._credentials = credentials;
        this._fingerprint = next;
        return true;
    }

    /**
     * Connects and authorizes. Resolves with the resulting state - it never
     * throws for an expected outcome (`expired`, `error`), because the runtime
     * must be able to record the state and keep the process alive for PM2.
     *
     * The underlying `api_base.init()` performs the browser's exact startup
     * sequence: connect the authenticated socket, `authorize()`, fetch active
     * symbols and register subscriptions.
     */
    async connect(options: ConnectOptions = {}): Promise<BotState> {
        const timeoutMs = options.timeoutMs ?? 30_000;

        if (this._closed) return this._setState('stopped', 'connection already closed');
        if (this._state === 'authenticated') return this._state;

        this._lastFailure = null;
        this._lastError = null;
        this._setState('starting', `account ${this._credentials.accountId}`);
        this._attachListeners();

        let initError: unknown = null;
        try {
            // 1. Publish the credentials where the existing auth stack reads them.
            //    `AuthSessionManager` owns these storage keys - we never write them.
            this._deps.authSession.setActiveAccount(this._credentials.accountId, this._credentials.accessToken);

            // 2. Account Mode makes WebSocketManager mint an OTP WebSocket URL.
            //    Mandatory for Ory tokens: Deriv refuses them on the public socket.
            this._deps.accountMode.enableAccountMode();

            // 3. The same entry point the browser application calls on startup.
            await withTimeout(this._deps.apiBase.init(), timeoutMs, 'api_base.init()');
        } catch (error) {
            initError = error;
            this._lastError = safeErrorText(error);
        }

        if (this._closed) return this._setState('stopped', 'closed while connecting');

        const next = this._classify(initError);
        this._logOutcome(next);
        return this._setState(next, this._detailFor(next));
    }

    /**
     * Renews authentication.
     *
     * Renewal means minting a FRESH OTP WebSocket credential from the stored
     * access token and reconnecting - the mechanism the application already uses
     * (`AuthManager.refreshNow`). The cached OTP URL must be invalidated first,
     * otherwise the reconnect would reuse the credential that just failed.
     *
     * If the access token itself is refused, the outcome is `expired` and only
     * the user can fix it by completing the OAuth flow again.
     */
    async refreshAuthentication(options: ConnectOptions = {}): Promise<BotState> {
        if (this._closed) return this._setState('stopped', 'connection already closed');
        if (this._state === 'authenticated') return this._state;

        this._setState('starting', 'renewing OTP credential');
        try {
            this._deps.authSession.invalidateOtpCache();
        } catch (error) {
            this._lastError = safeErrorText(error);
        }
        try {
            this._deps.apiBase.terminate();
        } catch (error) {
            this._lastError = safeErrorText(error);
        }

        return this.connect(options);
    }

    /**
     * Stops strategy transport: drops listeners, closes the Deriv socket and
     * records `stopped`. Idempotent.
     */
    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        this._setState('stopping', 'shutdown requested');
        this._detachListeners();

        try {
            // WebSocketManager.disconnect() - closes the socket and cancels
            // reconnect scheduling.
            this._deps.apiBase.terminate();
        } catch (error) {
            this._lastError = safeErrorText(error);
        }

        this._setState('stopped', 'shutdown complete');
    }

    /**
     * Maps the observed outcome onto a runtime state.
     *
     * `api_base.is_authorized` is treated as ground truth: Deriv accepting the
     * token is the only positive evidence of a working authenticated session.
     */
    private _classify(initError: unknown): BotState {
        if (this._deps.apiBase.is_authorized) return 'authenticated';

        const failure = this._lastFailure;
        if (failure) {
            const code = typeof failure.code === 'string' ? failure.code : '';
            if (EXPIRED_AUTH_CODES.has(code)) return 'expired';
            if (code) return 'error';
            return EXPIRED_AUTH_HINTS.test(String(failure.message ?? '')) ? 'expired' : 'error';
        }

        if (initError) {
            return EXPIRED_AUTH_HINTS.test(this._lastError ?? '') ? 'expired' : 'error';
        }

        // Init completed but Deriv never authorized: the credential is not
        // usable, so the next step is user re-authentication.
        return 'expired';
    }

    private _detailFor(state: BotState): string {
        if (state === 'authenticated') return `authorized as ${this._credentials.accountId}`;
        if (this._lastFailure?.code) return `Deriv refused the credential (${this._lastFailure.code})`;
        if (this._lastError) return this._lastError;
        return state;
    }

    /** Logs one redacted line per state change - never a credential. */
    private _logOutcome(state: BotState): void {
        // eslint-disable-next-line no-console
        console.log(
            `[bot-runtime] deriv connection ${state} | account=${this._credentials.accountId} | ` +
                `credential=${maskCredential(this._credentials.accessToken)} | ` +
                `source=${this._credentials.source}`
        );
    }

    private _setState(state: BotState, detail = ''): BotState {
        this._state = state;
        for (const listener of this._listeners) {
            try {
                listener(state, detail);
            } catch {
                // A listener must never be able to break the state machine.
            }
        }
        return state;
    }

    private _attachListeners(): void {
        this._detachListeners();
        this._unsubscribes.push(
            this._deps.eventBus.on('auth:failed', payload => {
                // Deriv refused the credential. Recorded, never logged raw.
                this._lastFailure = payload ?? null;
            })
        );
    }

    private _detachListeners(): void {
        for (const unsubscribe of this._unsubscribes.splice(0)) {
            try {
                unsubscribe();
            } catch {
                // Detaching must never throw during shutdown.
            }
        }
    }
}
