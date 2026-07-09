/**
 * AccountModeController
 *
 * The SINGLE entry point for transitioning the application from
 * Public Mode into Account Mode.
 *
 * RULES:
 *   - No component, hook, or utility may independently call:
 *       authorize(), initiateDerivAuth(), getActiveSessions(),
 *       getOtpWsUrl(), setActiveAccount(), or authorizeAndSubscribe()
 *     without routing through this controller.
 *
 *   - `enter({ fromLoginButton: true })` is the ONLY function that may
 *     initiate authentication. It must be called with fromLoginButton: true.
 *
 *   - `enableAccountMode()` is called internally by enter() when auth is
 *     dispatched, and by App.tsx when restoring a post-OAuth redirect.
 *
 *   - `restoreFromUrl()` is the only function that may write account
 *     credentials from a URL/localStorage restore path (post-OAuth only).
 *
 * Callers (Checkpoint 3 — fully architectural):
 *   - header.tsx Login button onClick      → enter({ fromLoginButton: true })
 *   - App.tsx post-OAuth URL restore       → enableAccountMode() + restoreFromUrl()
 *   - AuthManager auth:success listener    → _startRefreshCycle() (via EventBus)
 */

import { AuthSessionManager } from './AuthSessionManager';
import { initiateDerivAuth } from './pkce';

export type EnterAccountModeOptions = {
    /**
     * True when called from the Login / Connect to Deriv button.
     * False for automatic startup calls (will be removed in Checkpoint 3).
     */
    fromLoginButton?: boolean;

    /** Optional callback to update an authenticating spinner in the UI. */
    setIsAuthenticating?: (value: boolean) => void;

    /**
     * Async function from useTMB that resolves TMB (Token-based Mode) status.
     * The controller calls this itself so the branching logic is owned here.
     */
    isTmbEnabled: () => Promise<boolean>;

    /**
     * onRenderTMBCheck from useTMB.
     * Handles session restoration via the Deriv TMB OAuth server.
     */
    onRenderTMBCheck: (
        fromLoginButton?: boolean,
        setIsAuthenticating?: (value: boolean) => void
    ) => Promise<void>;

    /**
     * Whether the PKCE redirect conditions are met.
     * Computed by Layout from isLoggedInCookie + missing accounts.
     */
    shouldAuthenticate?: boolean;

    /** Currency from URL / sessionStorage — preserved in sessionStorage before redirect. */
    currency?: string;
};

class AccountModeControllerClass {
    /**
     * Runtime flag — TRUE only after this controller explicitly enables Account Mode.
     *
     * NEVER set from localStorage, cookies, or existing tokens.
     * Set ONLY inside enter() when an auth action is actually dispatched.
     */
    private _accountModeActive = false;

    /**
     * Mark Account Mode as active.
     * Called internally by enter() when auth is actually dispatched.
     * May also be called by the callback page after a successful PKCE exchange.
     */
    enableAccountMode(): void {
        if (!this._accountModeActive) {
            console.log('[AccountModeController] Account Mode ENABLED');
            this._accountModeActive = true;
        }
    }

    /**
     * Returns true only after the controller has explicitly enabled Account Mode.
     * Used by api-base and WebSocketManager to gate all account-mode operations.
     */
    isAccountModeActive(): boolean {
        return this._accountModeActive;
    }

    /**
     * Enter Account Mode.
     *
     * THIS IS THE ONLY FUNCTION THAT MAY INITIATE AUTHENTICATION.
     *
     * Routes to TMB session restore (if TMB enabled) or PKCE OAuth
     * redirect (if shouldAuthenticate or fromLoginButton).
     *
     * enableAccountMode() is called INSIDE each branch — only when auth
     * is actually dispatched, never speculatively.
     */
    async enter(options: EnterAccountModeOptions): Promise<void> {
        const {
            fromLoginButton = false,
            setIsAuthenticating,
            isTmbEnabled,
            onRenderTMBCheck,
            shouldAuthenticate = false,
            currency,
        } = options;

        const tmbEnabled = await isTmbEnabled();

        if (tmbEnabled) {
            this.enableAccountMode();
            await onRenderTMBCheck(fromLoginButton, setIsAuthenticating);
        } else if (shouldAuthenticate || fromLoginButton) {
            this.enableAccountMode();
            if (currency) {
                sessionStorage.setItem('query_param_currency', currency);
            }
            await initiateDerivAuth();
        }
    }

    /**
     * Restore the active account from URL params and localStorage.
     *
     * All credential writes from URL/localStorage restore paths MUST
     * go through this method so they are visible and traceable.
     *
     * Currently called from App.tsx on startup.
     * Will be gated behind a login-completed flag in Checkpoint 3.
     */
    restoreFromUrl(loginid: string, token: string): void {
        AuthSessionManager.setActiveAccount(loginid, token);
    }

}

export const AccountModeController = new AccountModeControllerClass();
