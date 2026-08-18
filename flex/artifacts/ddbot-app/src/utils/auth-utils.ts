/**
 * Utility functions for authentication-related operations
 */
import Cookies from 'js-cookie';

/**
 * Clears authentication data from local storage and reloads the page.
 *
 * Also clears the `logged_state` cookie — this flag marks "session was
 * established via the OAuth callback" and must never outlive the token it
 * describes. Leaving it set after the token is gone produces a desynced
 * state where `logged_state=true` but AuthSessionManager has no access
 * token (see AuthSessionManager.normalizeAuthState() desync detection).
 */
export const clearAuthData = (is_reload: boolean = true): void => {
    localStorage.removeItem('accountsList');
    localStorage.removeItem('clientAccounts');
    localStorage.removeItem('callback_token');
    localStorage.removeItem('authToken');
    localStorage.removeItem('active_loginid');
    localStorage.removeItem('client.accounts');
    localStorage.removeItem('client.country');
    sessionStorage.removeItem('query_param_currency');
    Cookies.remove('logged_state', { path: '/' });
    if (is_reload) {
        location.reload();
    }
};

