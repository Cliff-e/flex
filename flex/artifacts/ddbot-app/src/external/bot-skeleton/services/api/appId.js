/**
 * appId.js — Auth bridge for the bot-skeleton.
 *
 * All auth reads go through AuthSessionManager (single source of truth).
 * No direct localStorage reads for auth data.
 */
import { WebSocketManager } from '@/utils/WebSocketManager';
import { AuthSessionManager } from '@/utils/AuthSessionManager';

export const getAppId = () =>
    (typeof import.meta !== 'undefined'
        ? import.meta.env?.VITE_DERIV_APP_ID
        : undefined) || '33gBzpTA0Py8ehX45PBXr';

/**
 * @deprecated — use WebSocketManager.wasLastConnectionOtp()
 */
export const wasLastConnectionOtp = () => WebSocketManager.wasLastConnectionOtp();

/**
 * @deprecated — use WebSocketManager.getPendingOtpToken()
 */
export const getPendingOtpToken = () => WebSocketManager.getPendingOtpToken();

/**
 * @deprecated — use WebSocketManager.connect() directly.
 */
export const generateDerivApiInstance = async () => {
    await WebSocketManager.connect();
    return WebSocketManager.getApi();
};

/** Returns the active loginid via AuthSessionManager. */
export const getLoginId = () => {
    return AuthSessionManager.getAuthInfo().accountId;
};

/** Returns the active access token via AuthSessionManager. */
export const V2GetActiveToken = () => {
    return AuthSessionManager.getAuthInfo().accessToken;
};

/** Returns the active account id via AuthSessionManager. */
export const V2GetActiveClientId = () => {
    return AuthSessionManager.getAuthInfo().accountId;
};

/** Returns { token, account_id } via AuthSessionManager. */
export const getToken = () => {
    const { accessToken, accountId } = AuthSessionManager.getAuthInfo();
    return {
        token: accessToken ?? undefined,
        account_id: accountId ?? undefined,
    };
};
