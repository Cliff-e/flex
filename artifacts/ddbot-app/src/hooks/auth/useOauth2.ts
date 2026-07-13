/**
 * useOauth2 — canonical authentication utilities.
 *
 * Legacy OIDC (OAuth2Logout, isSingleLoggingIn SSO detection) has been removed.
 * All auth state comes exclusively from AuthSessionManager.
 *
 * - `oAuthLogout`          — logs the user out via AuthSessionManager canonical flow.
 * - `retriggerOAuth2Login` — redirects to the DO backend login endpoint.
 * - `isSingleLoggingIn`    — always false; SSO detection removed. Kept in return type
 *                            for compatibility with any callers that destructure it.
 */
import Cookies from 'js-cookie';
import RootStore from '@/stores/root-store';
import { initiateDerivAuth } from '@/utils/pkce';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { EventBus } from '@/utils/EventBus';
import { Analytics } from '@deriv-com/analytics';

export const useOauth2 = ({
    handleLogout,
    client,
}: {
    handleLogout?: () => Promise<void>;
    client?: RootStore['client'];
} = {}) => {
    // isSingleLoggingIn was the OIDC SSO detection flag.
    // The canonical flow uses AuthSessionManager; this is always false.
    // The `isLoggedIn && !activeLoginid` branch in header.tsx covers
    // the "token present but WS not yet authorized" loading state.
    const isSingleLoggingIn = false;

    /**
     * Canonical logout:
     *   1. Clear in-memory auth state immediately (before localStorage) so no
     *      observer sees a window where storage is cleared but in-memory says "authorized".
     *   2. Run MobX store logout (resets UI state, unsubscribes WS streams, etc.)
     *   3. Clear all auth keys from localStorage.
     *   4. Clear the session cookie.
     *   5. Reload to reset all runtime state to guest/public mode.
     */
    const logoutHandler = async () => {
        client?.setIsLoggingOut(true);
        try {
            AuthSessionManager.clearSession();
            EventBus.emit('auth:logout');

            if (handleLogout) {
                await handleLogout().catch(err => console.error('[useOauth2] logout error:', err));
            } else if (client) {
                await client.logout().catch(err => console.error('[useOauth2] logout error:', err));
            }

            localStorage.removeItem('authToken');
            localStorage.removeItem('active_loginid');
            localStorage.removeItem('clientAccounts');
            localStorage.removeItem('accountsList');
            localStorage.removeItem('restAccounts');
            localStorage.removeItem('client_account_details');

            Cookies.remove('logged_state', { path: '/' });

            Analytics.reset();

            window.location.href = window.location.origin;
        } catch (error) {
            console.error('[useOauth2] logout failed:', error);
            window.location.reload();
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
