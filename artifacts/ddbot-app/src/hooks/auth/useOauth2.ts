import { useState, useEffect } from 'react';
import Cookies from 'js-cookie';
import RootStore from '@/stores/root-store';
import { initiateDerivAuth } from '@/utils/pkce';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { Analytics } from '@deriv-com/analytics';
import { OAuth2Logout } from '@deriv-com/auth-client';

/**
 * Provides OAuth2 utility functions for login and logout.
 *
 * - `oAuthLogout`          — logs the user out via the @deriv-com/auth-client flow.
 * - `retriggerOAuth2Login` — redirects to the DO backend login endpoint.
 * - `isSingleLoggingIn`    — true when a silent login or logout transition is pending.
 */
export const useOauth2 = ({
    handleLogout,
    client,
}: {
    handleLogout?: () => Promise<void>;
    client?: RootStore['client'];
} = {}) => {
    const [isSingleLoggingIn, setIsSingleLoggingIn] = useState(false);

    // Read auth state through AuthSessionManager — no direct localStorage reads.
    const canonical = AuthSessionManager.getCanonicalAuthState();
    const isClientAccountsPopulated = canonical.isAuthenticated;
    const isSilentLoginExcluded =
        window.location.pathname.includes('callback') ||
        window.location.pathname.includes('endpoint');

    const loggedState = Cookies.get('logged_state');

    useEffect(() => {
        window.addEventListener('unhandledrejection', event => {
            if (event?.reason?.error?.code === 'InvalidToken') {
                setIsSingleLoggingIn(false);
            }
        });
    }, []);

    useEffect(() => {
        const willEventuallySSO = loggedState === 'true' && !isClientAccountsPopulated;
        const willEventuallySLO = loggedState === 'false' && isClientAccountsPopulated;

        if (!isSilentLoginExcluded && (willEventuallySSO || willEventuallySLO)) {
            setIsSingleLoggingIn(true);
        } else {
            setIsSingleLoggingIn(false);
        }
    }, [isClientAccountsPopulated, loggedState, isSilentLoginExcluded]);

    // ── SSO recovery ─────────────────────────────────────────────────────────
    // When isSingleLoggingIn is true the app shows a loading spinner and waits
    // for silent session restoration (originally via requestSessionActive()).
    // That mechanism is no longer available. Without a resolver the spinner
    // shows forever and the Login button is never rendered.
    //
    // This effect is the resolver:
    //   • If auth state is already populated (valid token + loginid) → recovery
    //     succeeded; the main SSO effect will clear isSingleLoggingIn naturally
    //     when isClientAccountsPopulated flips to true on the next render.
    //   • Otherwise → the browser has a stale logged_state=true cookie with no
    //     backing token. Clear only that cookie and exit SSO mode so the header
    //     falls through to the Login button.
    //
    // This intentionally does NOT touch authToken, active_loginid, accountsList,
    // or clientAccounts — those may contain valid data from a concurrent auth
    // flow (e.g. CallbackPage writing in a background tab).
    useEffect(() => {
        if (!isSingleLoggingIn) return;

        console.log('[SSO] entered silent login');
        console.log('[SSO] attempting recovery');

        // A valid session already exists — nothing to recover.
        // The main SSO effect will flip isSingleLoggingIn back to false once
        // isClientAccountsPopulated becomes true.
        if (isClientAccountsPopulated) {
            console.log('[SSO] recovery succeeded');
            return;
        }

        // logged_state=true but no token and no loginid → stale browser session.
        // Clear only the stale marker; never delete real credential keys.
        console.log('[SSO] stale browser session detected');
        console.log('[SSO] clearing stale browser markers');
        Cookies.remove('logged_state', { path: '/' });
        console.log('[SSO] leaving silent login');
        setIsSingleLoggingIn(false);
    }, [isSingleLoggingIn, isClientAccountsPopulated]);

    const logoutHandler = async () => {
        client?.setIsLoggingOut(true);
        try {
            await OAuth2Logout({
                redirectCallbackUri: window.location.origin,
                WSLogoutAndRedirect: handleLogout ?? (() => Promise.resolve()),
                postLogoutRedirectUri: window.location.origin,
            }).catch(err => {
                console.error(err);
            });
            await client?.logout().catch(err => {
                console.error('Error during logout:', err);
            });
            Analytics.reset();
        } catch (error) {
            console.error(error);
        }
    };

    const retriggerOAuth2Login = async () => {
        try {
            await initiateDerivAuth();
        } catch (error) {
            console.error('[useOauth2] retriggerOAuth2Login error:', error);
        }
    };

    return { oAuthLogout: logoutHandler, retriggerOAuth2Login, isSingleLoggingIn };
};
