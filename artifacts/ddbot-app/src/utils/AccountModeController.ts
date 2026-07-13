/**
 * AccountModeController
 *
 * The SINGLE entry point for transitioning the application from
 * Public Mode into Account Mode.
 *
 * RULES:
 *   - No component, hook, or utility may independently call:
 *       authorize(), initiateDerivAuth(), getOtpWsUrl(),
 *       setActiveAccount(), or authorizeAndSubscribe()
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
 * Authentication always uses the canonical DO backend PKCE flow.
 * TMB (Token-Based Mode) has been removed — isTmbEnabled and onRenderTMBCheck
 * are kept as optional in the options type for call-site compatibility but
 * are never invoked.
 */

import { AuthSessionManager } from './AuthSessionManager';
import { initiateDerivAuth } from './pkce';

export type EnterAccountModeOptions = {
    /**
     * True when called from the Login / Connect to Deriv button.
     * False for automatic startup calls.
     */
    fromLoginButton?: boolean;

    /** Optional callback to update an authenticating spinner in the UI. */
    setIsAuthenticating?: (value: boolean) => void;

    /**
     * @deprecated TMB removed. Kept for call-site compatibility only; not invoked.
     */
    isTmbEnabled?: () => Promise<boolean>;

    /**
     * @deprecated TMB removed. Kept for call-site compatibility only; not invoked.
     */
    onRenderTMBCheck?: (
        fromLoginButton?: boolean,
        setIsAuthenticating?: (value: boolean) => void
    ) => Promise<void>;

    /**
     * Whether the PKCE redirect conditions are met.
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
     * Always redirects to the canonical DO backend PKCE flow via initiateDerivAuth().
     * TMB options (isTmbEnabled, onRenderTMBCheck) are accepted for call-site
     * compatibility but are never invoked.
     */
    async enter(options: EnterAccountModeOptions = {}): Promise<void> {
        const {
            fromLoginButton = false,
            setIsAuthenticating,
            shouldAuthenticate = false,
            currency,
        } = options;

        if (fromLoginButton || shouldAuthenticate) {
            this.enableAccountMode();
            if (currency) {
                sessionStorage.setItem('query_param_currency', currency);
            }
            await initiateDerivAuth();
        }

        if (setIsAuthenticating) setIsAuthenticating(false);
    }

    /**
     * Restore the active account from URL params and localStorage.
     *
     * All credential writes from URL/localStorage restore paths MUST
     * go through this method so they are visible and traceable.
     *
     * Currently called from App.tsx on startup.
     */
    restoreFromUrl(loginid: string, token: string): void {
        AuthSessionManager.setActiveAccount(loginid, token);
    }
}

export const AccountModeController = new AccountModeControllerClass();
