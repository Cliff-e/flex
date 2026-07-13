import Cookies from 'js-cookie';
import { TAuthData } from '@/types/api-types';

const APP_ID =
    (typeof import.meta !== 'undefined'
        ? (import.meta as unknown as Record<string, Record<string, string>>).env?.VITE_DERIV_APP_ID
        : undefined) || '33gBzpTA0Py8ehX45PBXr';
const OTP_REST_BASE = 'https://api.derivws.com/trading/v1/options';
const OTP_CACHE_TTL_MS = 25_000;

function maskToken(t: string | null | undefined): string {
    if (!t) return '(none)';
    if (t.length <= 12) return t.slice(0, 4) + '…';
    return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

/**
 * Returns true when `id` looks like a legitimate account identifier.
 *
 * Strategy: blocklist clearly-invalid values rather than encoding
 * Deriv-specific naming rules, so future account ID formats are not
 * unnecessarily rejected.
 *
 * Rejects:
 *   - null / undefined / empty string
 *   - leading or trailing whitespace
 *   - double-underscore sentinel pattern  (__pending__, __test__, …)
 *   - stringified JS primitives           ("null", "undefined", "NaN")
 *   - pure-whitespace strings
 *   - values outside a plausible length   (< 3 or > 24 chars)
 *   - characters outside alphanumeric + hyphen
 *   - purely-numeric strings              (account IDs always start with letters)
 *
 * Note: based on observed Deriv account ID formats as of July 2026
 * (CR…, VR…, MX…, MLT…, MF…). The pattern requirement (letter prefix +
 * digits) is kept as a lightweight sanity check, not an external API contract.
 */
function isValidDerivLoginid(id: string | null | undefined): id is string {
    if (!id || typeof id !== 'string') return false;
    if (id !== id.trim()) return false;                       // whitespace padding
    if (id.length < 3 || id.length > 24) return false;       // implausible length
    if (id.includes('__')) return false;                      // sentinel pattern
    if (/^(null|undefined|nan)$/i.test(id)) return false;    // stringified JS
    if (!/^[A-Za-z0-9-]+$/.test(id)) return false;           // unexpected chars
    if (!/[A-Za-z]/.test(id)) return false;                  // must start with a letter prefix
    if (!/[0-9]/.test(id)) return false;                     // must contain digits
    return true;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AuthInfo = {
    accountId: string | null;
    accessToken: string | null;
    appId: string;
};

/**
 * Which system established the current auth session.
 * Priority (highest → lowest):
 *   ws-authorized > oauth-callback > none
 */
export type AuthSource =
    | 'ws-authorized'   // WS authorize() succeeded — highest authority
    | 'oauth-callback'  // CallbackPage wrote token after DO backend exchange
    | 'none';           // No credentials found

export type CanonicalAuthState = {
    /** Has valid credentials (token + loginid present in storage). */
    isAuthenticated: boolean;
    /** WS authorize() succeeded for the current token — trading is live. */
    isAuthorized: boolean;
    accountId: string | null;
    accessToken: string | null;
    /** Which system is the primary owner of the current session. */
    source: AuthSource;
    /** True when two or more sources disagree about the current session. */
    desynced: boolean;
    /** Human-readable reasons for the desync (empty when desynced=false). */
    desyncReasons: string[];
};

type AuthChangeCallback = (isAuthorized: boolean) => void;

// ---------------------------------------------------------------------------
// AuthSessionManagerClass
// ---------------------------------------------------------------------------

class AuthSessionManagerClass {
    private _otpCache: { url: string; token: string | null; expiresAt: number } | null = null;
    private _pendingOtpFetch: Promise<{ url: string; token: string | null }> | null = null;
    private _subscribers = new Set<AuthChangeCallback>();

    // WS auth state — set by api-base via setWsAuthorized()
    private _wsAuthorized = false;
    private _wsAuthData: TAuthData | null = null;

    // ---------------------------------------------------------------------------
    // WRITE API — all auth state changes flow through here
    // ---------------------------------------------------------------------------

    /**
     * Called by api-base after every WS authorize() result.
     * This is the ONLY external setter for WS auth state.
     */
    setWsAuthorized(authorized: boolean, authData: TAuthData | null): void {
        const prev = this._wsAuthorized;
        this._wsAuthorized = authorized;
        this._wsAuthData = authData;
        console.log('[AUTH-ASM][setWsAuthorized]',
            `${prev} → ${authorized}`,
            '| loginid:', authData?.loginid ?? '(none)',
        );
        if (prev !== authorized) {
            this.notifyAuthChange(authorized);
        }
    }

    /**
     * Atomically update the active account in localStorage and invalidate the
     * OTP cache so the next WS reconnect uses the new account's credentials.
     *
     * All account switches MUST go through this method — never write
     * authToken or active_loginid to localStorage directly.
     *
     * Pass an empty string for `loginid` to store only the token (e.g. during
     * the OAuth callback before the accounts list has been fetched).
     */
    setActiveAccount(loginid: string, token: string): void {
        const validLoginid = isValidDerivLoginid(loginid);
        if (loginid && !validLoginid) {
            console.warn('[AUTH-ASM][setActiveAccount] REJECTED invalid loginid — will not persist:',
                loginid, '| token:', maskToken(token));
        } else {
            console.log('[AUTH-ASM][setActiveAccount] switching to loginid:', loginid || '(empty — token only)',
                '| token:', maskToken(token));
        }
        localStorage.setItem('authToken', token);
        if (validLoginid) {
            localStorage.setItem('active_loginid', loginid);
        }
        // Invalidate OTP cache — new account needs a fresh OTP URL
        this._otpCache = null;
        this._pendingOtpFetch = null;
        // Notify all subscribers that auth state changed
        this.notifyAuthChange(this._wsAuthorized);
    }

    /**
     * Fix 7: Atomically write the complete account list and client accounts
     * map to localStorage. All writers of `accountsList` MUST use this method
     * so that account-list mutations are centrally traceable.
     *
     * @param accountsList   loginid → access-token map (account switcher)
     * @param clientAccounts loginid → account-detail map (UI display)
     */
    setAccounts(
        accountsList: Record<string, string>,
        clientAccounts: Record<string, unknown>,
    ): void {
        localStorage.setItem('accountsList', JSON.stringify(accountsList));
        localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));
        this.notifyAuthChange(this._wsAuthorized);
    }

    /**
     * Returns the access token for a specific account from the stored account
     * list. Callers that need to look up a token for account switching should
     * use this instead of reading localStorage directly.
     *
     * Returns null when the account is not found or has no token.
     */
    getAccountToken(loginid: string): string | null {
        try {
            const raw = localStorage.getItem('accountsList');
            if (!raw) return null;
            const list = JSON.parse(raw) as Record<string, string>;
            return list[loginid] ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Atomically clear all in-memory auth state and notify every subscriber.
     *
     * Call at the START of logout — before clearing localStorage — so the
     * canonical state transitions to "not authorized" immediately while the
     * private WebSocket is still open for the WS logout() call.
     *
     * This method intentionally does NOT clear localStorage; the caller owns
     * that step so the WS logout() request can still proceed.
     */
    clearSession(): void {
        const wasAuthorized = this._wsAuthorized;
        this._wsAuthorized = false;
        this._wsAuthData = null;
        this._otpCache = null;
        this._pendingOtpFetch = null;
        console.log('[AUTH-ASM][clearSession] All in-memory auth state cleared',
            '| wasAuthorized:', wasAuthorized,
        );
        // Always notify — even when wasAuthorized was already false —
        // so any subscriber holding stale state is forced to re-read.
        this.notifyAuthChange(false);
    }

    // ---------------------------------------------------------------------------
    // READ API — all consumers read through here
    // ---------------------------------------------------------------------------

    /**
     * Primary read API for all modules. Returns the single canonical view of
     * the current authentication state, reconciling all sources.
     *
     * No module should read localStorage directly for auth decisions.
     */
    getCanonicalAuthState(): CanonicalAuthState {
        return this.normalizeAuthState();
    }

    /**
     * Convenience accessor for token + loginid + appId.
     * AuthSessionManager owns all reads of these keys from localStorage.
     */
    getAuthInfo(): AuthInfo {
        const rawLoginid =
            localStorage.getItem('active_loginid') ||
            localStorage.getItem('active_account_id') ||
            null;

        let accountId: string | null = null;
        if (rawLoginid !== null) {
            if (isValidDerivLoginid(rawLoginid)) {
                accountId = rawLoginid;
            } else {
                // Self-heal: stale/sentinel value (e.g. '__pending__') — remove it
                // so it cannot propagate to OTP or WS authorize().
                console.warn(
                    '[AUTH-ASM][getAuthInfo] Invalid persisted loginid detected.\n' +
                    'Removing stale value from localStorage.\n' +
                    `value: ${JSON.stringify(rawLoginid)}\n` +
                    'reason: failed validation'
                );
                localStorage.removeItem('active_loginid');
                localStorage.removeItem('active_account_id');
                accountId = null;
            }
        }

        const accessToken =
            localStorage.getItem('authToken') ||
            localStorage.getItem('active_token') ||
            localStorage.getItem('token') ||
            null;

        // Ory tokens (ory_at_…) are account-scoped: they can ONLY be used
        // via an OTP WS URL (POST /accounts/{id}/otp → signed WS URL).
        // On the public WS, Deriv rejects them with InputValidationFailed —
        // regardless of whether account_id is present in the authorize payload.
        //
        // When accountId is null but an Ory token is in storage, the app is
        // stuck: OTP fetch refuses (no accountId), authorize on public WS
        // fails, and the cycle repeats on every page load.
        //
        // Fix: evict the orphaned Ory token here so the next call returns
        // { accountId: null, accessToken: null } → clean logged-out state →
        // the login button becomes visible and the user can re-authenticate.
        if (!accountId && accessToken?.startsWith('ory_at_')) {
            console.warn(
                '[AUTH-ASM][getAuthInfo] Orphaned Ory token detected — no valid account ID.\n' +
                'Ory tokens require an OTP WS URL (account-scoped). Removing to prevent\n' +
                'InputValidationFailed loop on public WS. User must log in again.'
            );
            localStorage.removeItem('authToken');
            localStorage.removeItem('active_token');
            localStorage.removeItem('token');
            return { accountId: null, accessToken: null, appId: APP_ID };
        }

        return { accountId, accessToken, appId: APP_ID };
    }

    /** True when credentials (token + loginid) are present in storage. */
    isAuthenticated(): boolean {
        const { accountId, accessToken } = this.getAuthInfo();
        return !!(accountId && accessToken);
    }

    /** True only when WS authorize() has succeeded — use to gate trading. */
    isAuthorized(): boolean {
        return this._wsAuthorized;
    }

    // ---------------------------------------------------------------------------
    // OTP / WebSocket URL
    // ---------------------------------------------------------------------------

    /**
     * Returns a valid OTP WS URL + extracted OTP token.
     * Deduplicates concurrent callers and caches the result for OTP_CACHE_TTL_MS.
     */
    async getOtpWsUrl(): Promise<{ url: string; token: string | null }> {
        if (this._otpCache && Date.now() < this._otpCache.expiresAt) {
            return { url: this._otpCache.url, token: this._otpCache.token };
        }

        if (this._pendingOtpFetch) {
            return this._pendingOtpFetch;
        }

        const { accountId, accessToken, appId } = this.getAuthInfo();
        if (!accountId || !accessToken) {
            throw new Error('Not authenticated — log in first');
        }

        this._pendingOtpFetch = this._fetchOtp(accountId, accessToken, appId)
            .then(result => {
                this._otpCache = { ...result, expiresAt: Date.now() + OTP_CACHE_TTL_MS };
                this._pendingOtpFetch = null;
                return result;
            })
            .catch(err => {
                this._pendingOtpFetch = null;
                throw err;
            });

        return this._pendingOtpFetch;
    }

    invalidateOtpCache(): void {
        this._otpCache = null;
        console.log('[AUTH-ASM][invalidateOtpCache] OTP cache cleared');
    }

    // ---------------------------------------------------------------------------
    // Subscription
    // ---------------------------------------------------------------------------

    onAuthChange(cb: AuthChangeCallback): () => void {
        this._subscribers.add(cb);
        return () => this._subscribers.delete(cb);
    }

    notifyAuthChange(isAuthorized: boolean): void {
        this._subscribers.forEach(cb => {
            try { cb(isAuthorized); } catch {}
        });
    }

    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------

    private detectAuthSource(): AuthSource {
        const { accessToken } = this.getAuthInfo();
        if (!accessToken) return 'none';
        if (Cookies.get('logged_state') === 'true') return 'oauth-callback';
        return 'none';
    }

    private normalizeAuthState(): CanonicalAuthState {
        const { accessToken, accountId } = this.getAuthInfo();
        const lsSource = this.detectAuthSource();
        const source: AuthSource = this._wsAuthorized ? 'ws-authorized' : lsSource;

        const desyncReasons: string[] = [];

        if (this._wsAuthorized && !accessToken) {
            desyncReasons.push('WS is authorized but accessToken is absent from localStorage');
        }

        if (this._wsAuthorized && this._wsAuthData?.loginid && accountId &&
            this._wsAuthData.loginid !== accountId) {
            desyncReasons.push(
                `WS loginid (${this._wsAuthData.loginid}) differs from localStorage active_loginid (${accountId})`
            );
        }

        if (!this._wsAuthorized && Cookies.get('logged_state') === 'true' && accessToken) {
            desyncReasons.push('logged_state=true cookie + token present but WS has not authorized yet');
        }

        if (Cookies.get('logged_state') === 'true' && !accessToken) {
            desyncReasons.push('logged_state=true cookie but accessToken is absent from localStorage');
        }

        if (desyncReasons.length > 0) {
            desyncReasons.forEach(reason => {
                console.warn('[AUTH-DESYNC][AuthSessionManager]', reason);
            });
        }

        return {
            isAuthenticated: !!(accessToken && accountId),
            isAuthorized: this._wsAuthorized,
            accountId,
            accessToken,
            source,
            desynced: desyncReasons.length > 0,
            desyncReasons,
        };
    }

    private async _fetchOtp(
        accountId: string,
        accessToken: string,
        appId: string
    ): Promise<{ url: string; token: string | null }> {
        const endpoint = `${OTP_REST_BASE}/accounts/${accountId}/otp`;

        console.log('[AUTH-ASM][_fetchOtp] → POST', endpoint);

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Deriv-App-ID': appId,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`OTP request failed: ${response.status} ${response.statusText} — ${errText.slice(0, 200)}`);
        }

        const json = await response.json();
        const url: string | undefined = json?.data?.url;

        if (!url) {
            throw new Error(`OTP response missing data.url: ${JSON.stringify(json).slice(0, 200)}`);
        }

        let token: string | null = null;
        try {
            token = new URL(url).searchParams.get('otp');
        } catch {}

        console.log('[AUTH-ASM][_fetchOtp] OTP URL obtained | hasToken:', !!token);
        return { url, token };
    }
}

export const AuthSessionManager = new AuthSessionManagerClass();
