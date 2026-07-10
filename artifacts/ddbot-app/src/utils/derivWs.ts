export const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

export type AccountType = 'demo' | 'real';

export function detectAccountType(loginId: string): AccountType {
    return /^(VRT|VRW)/i.test(loginId) ? 'demo' : 'real';
}

/**
 * @deprecated Use AuthSessionManager.getOtpWsUrl() instead.
 * Kept only for call-sites that haven't been migrated yet.
 */
export async function fetchOtpWsUrl(
    accountId: string,
    accessToken: string,
    appId: string
): Promise<string> {
    const OTP_API_BASE = 'https://api.derivws.com/trading/v1/options';
    const url = `${OTP_API_BASE}/accounts/${accountId}/otp`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Deriv-App-ID': appId,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`OTP request failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    const wsUrl: string | undefined = json?.data?.url;

    if (!wsUrl) {
        throw new Error('OTP response did not contain a WebSocket URL');
    }

    return wsUrl;
}

/**
 * @deprecated Use AuthSessionManager.getAuthInfo() instead.
 */
export function getStoredAuthInfo(): {
    accountId: string | null;
    accessToken: string | null;
    appId: string;
} {
    const accountId =
        localStorage.getItem('active_loginid') ||
        localStorage.getItem('active_account_id') ||
        null;

    const accessToken =
        localStorage.getItem('authToken') ||
        localStorage.getItem('active_token') ||
        localStorage.getItem('token') ||
        null;

    const appId = (process.env.VITE_DERIV_APP_ID as string) || '33gBzpTA0Py8ehX45PBXr';

    return { accountId, accessToken, appId };
}
