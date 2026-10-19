/**
 * Demo balance reset — uses the supported Deriv Options REST endpoint.
 *
 * The legacy `topup_virtual` WebSocket call is NOT part of the new
 * api.derivws.com trading API, so resetting is done via:
 *
 *   POST /trading/v1/options/accounts/{account_id}/reset-demo-balance
 *
 * (200 OK with no body on success; demo accounts only.)
 */
import { AuthSessionManager } from './AuthSessionManager';

const DERIV_RESET_URL = 'https://api.derivws.com/trading/v1/options/accounts';

export class DemoResetError extends Error {
    code?: string;
    status?: number;

    constructor(message: string, code?: string, status?: number) {
        super(message);
        this.name = 'DemoResetError';
        this.code = code;
        this.status = status;
    }
}

export async function resetDemoBalance(accountId: string): Promise<void> {
    const { accessToken, appId } = AuthSessionManager.getAuthInfo();
    if (!accessToken) {
        throw new DemoResetError('Sign in to reset your demo balance.', 'unauthorized');
    }

    const id = encodeURIComponent(accountId);
    let response: Response;
    try {
        response = await fetch(`${DERIV_RESET_URL}/${id}/reset-demo-balance`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Deriv-App-ID': appId,
            },
        });
    } catch {
        throw new DemoResetError('Network error — could not reset your demo balance. Please try again.', 'network');
    }

    if (response.ok) return;

    let message = 'Failed to reset demo balance.';
    let code = 'reset-failed';
    try {
        const json = (await response.json()) as {
            errors?: Array<{ code?: string; message?: string }>;
        };
        const first = json?.errors?.[0];
        if (first?.message) message = first.message;
        if (first?.code) code = first.code;
    } catch {
        /* non-JSON error body — keep defaults */
    }

    throw new DemoResetError(message, code, response.status);
}
