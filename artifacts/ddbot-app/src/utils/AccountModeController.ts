/**
 * AccountModeController
 *
 * The SINGLE entry point for transitioning the application from
 * Public Mode into Account Mode.
 *
 * RULES:
 *   - No component, hook, or utility may independently call:
 *       authorize(), initiateDerivAuth(), getActiveSessions(),
 *       getOtpWsUrl(), setActiveAccount(), _startRefreshCycle(),
 *       or authorizeAndSubscribe()
 *     without routing through this controller.
 *
 *   - `enter()` is the only function that may initiate authentication.
 *
 *   - `restoreFromUrl()` is the only function that may write account
 *     credentials from a URL/localStorage restore path.
 *
 *   - `startRefreshCycle()` is the only external call site for starting
 *     the proactive token refresh timer.
 *
 * Current callers (Checkpoint 1 — behavior unchanged):
 *   - layout/index.tsx startup useEffect  → will be REMOVED in Checkpoint 3
 *   - header.tsx Login button onClick      → permanent (explicit user action)
 *   - App.tsx URL/localStorage restore     → will be GATED in Checkpoint 3
 *   - AuthManager.init() startup cycle     → will be REMOVED in Checkpoint 3
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

    /**
     * Start the proactive OTP token refresh cycle.
     *
     * All refresh-cycle starts MUST go through here.
     *
     * Currently called by AuthManager.init() when credentials are found
     * in localStorage on startup — will be removed in Checkpoint 3.
     * After that, the refresh cycle starts only via the auth:success
     * EventBus listener inside AuthManager.
     *
     * @param startCycle  The internal AuthManager method to invoke.
     */
    startRefreshCycle(startCycle: () => void): void {
        startCycle();
    }
}

export const AccountModeController = new AccountModeControllerClass();
