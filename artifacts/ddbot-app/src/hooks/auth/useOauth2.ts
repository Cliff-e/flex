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
