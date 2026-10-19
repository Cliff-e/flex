import { resetDemoBalance, DemoResetError } from '../demo-balance-reset';

jest.mock('../AuthSessionManager', () => ({
    AuthSessionManager: {
        getAuthInfo: jest.fn(),
    },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AuthSessionManager } = require('../AuthSessionManager') as {
    AuthSessionManager: { getAuthInfo: jest.Mock };
};

const resetEndpoint = (id: string) =>
    `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(id)}/reset-demo-balance`;

describe('resetDemoBalance', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (AuthSessionManager.getAuthInfo as jest.Mock).mockReturnValue({ accessToken: 'tok', appId: 'app-123' });
        (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
    });

    it('POSTs to the documented reset endpoint with auth headers', async () => {
        (global as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({ ok: true });

        await resetDemoBalance('VRTC123');

        expect((global as unknown as { fetch: jest.Mock }).fetch).toHaveBeenCalledWith(resetEndpoint('VRTC123'), {
            method: 'POST',
            headers: { Authorization: 'Bearer tok', 'Deriv-App-ID': 'app-123' },
        });
    });

    it('surfaces the API error message on a 400 response', async () => {
        (global as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
            ok: false,
            json: async () => ({ errors: [{ code: 'ValidationError', message: 'Only demo accounts can have their balance reset' }] }),
        });

        await expect(resetDemoBalance('CR123')).rejects.toThrow('Only demo accounts can have their balance reset');
    });

    it('throws a friendly network error when fetch rejects', async () => {
        (global as unknown as { fetch: jest.Mock }).fetch.mockRejectedValue(new Error('boom'));

        await expect(resetDemoBalance('VRTC123')).rejects.toThrow('Network error');
    });

    it('does not call fetch when there is no access token', async () => {
        (AuthSessionManager.getAuthInfo as jest.Mock).mockReturnValue({ accessToken: null, appId: 'app-123' });

        await expect(resetDemoBalance('VRTC123')).rejects.toBeInstanceOf(DemoResetError);
        await expect(resetDemoBalance('VRTC123')).rejects.toThrow('Sign in to reset your demo balance.');
        expect((global as unknown as { fetch: jest.Mock }).fetch).not.toHaveBeenCalled();
    });
});
