import { act, renderHook } from '@testing-library/react';
import * as observables from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { useApiBase } from '../useApiBase';

// The project's tsconfig does not include @types/node, so keep the mock
// factory self-contained via jest.requireActual (jest is allowed in a factory).

jest.mock('@/external/bot-skeleton/services/api/observables/connection-status-stream', () => {
    const { BehaviorSubject: Subject } = jest.requireActual('rxjs') as typeof import('rxjs');
    return {
        CONNECTION_STATUS: { OPENED: 'opened', CLOSED: 'closed', UNKNOWN: 'unknown' },
        connectionStatus$: new Subject('unknown'),
        isAuthorizing$: new Subject(false),
        account_list$: new Subject([]),
        authData$: new Subject(null),
    };
});

jest.mock('@/utils/AuthSessionManager', () => ({
    AuthSessionManager: {
        getStoredAccounts: jest.fn(),
        getAuthInfo: jest.fn(),
        getCanonicalAuthState: jest.fn(),
        onAuthChange: jest.fn(),
    },
}));

const authSessionMock = AuthSessionManager as unknown as {
    getStoredAccounts: jest.Mock;
    getAuthInfo: jest.Mock;
    getCanonicalAuthState: jest.Mock;
    onAuthChange: jest.Mock;
};

const realAccount = {
    loginid: 'CR123',
    currency: 'USD',
    is_virtual: 0,
    is_disabled: 0,
    landing_company_name: 'svg',
};

const demoAccount = {
    loginid: 'DOT90004580',
    currency: 'USD',
    is_virtual: 1,
    is_disabled: 0,
    landing_company_name: 'virtual',
};

let authChangeHandler: (() => void) | undefined;

describe('useApiBase account hydration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        authChangeHandler = undefined;

        observables.account_list$.next([]);
        observables.authData$.next(null);
        observables.connectionStatus$.next('unknown');
        observables.isAuthorizing$.next(false);

        authSessionMock.getStoredAccounts.mockReturnValue([realAccount, demoAccount]);
        authSessionMock.getAuthInfo.mockReturnValue({
            accountId: 'CR123',
            accessToken: 'token',
            appId: 'app-id',
        });
        authSessionMock.getCanonicalAuthState.mockReturnValue({
            isAuthenticated: true,
            isAuthorized: false,
            accountId: 'CR123',
            accessToken: 'token',
            source: 'oauth-callback',
            desynced: false,
            desyncReasons: [],
        });
        authSessionMock.onAuthChange.mockImplementation((cb: () => void) => {
            authChangeHandler = cb;
            return jest.fn();
        });
    });

    it('hydrates the selector from the canonical stored accounts before WS authorization', () => {
        const { result } = renderHook(() => useApiBase());

        expect(result.current.accountList).toEqual([realAccount, demoAccount]);
        expect(result.current.activeLoginid).toBe('CR123');
        // Display hydration must not pretend the WS session is authorized.
        expect(result.current.isAuthorized).toBe(false);
    });

    it('lets the WS authorize response take over from the hydrated snapshot', () => {
        const { result } = renderHook(() => useApiBase());
        const wsAccount = { ...realAccount, loginid: 'CR999', landing_company_name: 'maltainvest' };

        act(() => {
            observables.account_list$.next([wsAccount] as any);
            observables.authData$.next({ loginid: 'CR999', account_list: [wsAccount] } as any);
        });

        expect(result.current.accountList).toEqual([wsAccount]);
        expect(result.current.activeLoginid).toBe('CR999');
    });

    it('keeps an authoritative empty WS list after logout', () => {
        const { result } = renderHook(() => useApiBase());

        act(() => {
            observables.account_list$.next([realAccount] as any);
            observables.authData$.next({ loginid: 'CR123', account_list: [realAccount] } as any);
        });

        act(() => {
            observables.account_list$.next([]);
            observables.authData$.next(null);
        });

        expect(result.current.accountList).toEqual([]);
        expect(result.current.activeLoginid).toBe('');
    });

    it('refreshes the hydrated snapshot when the canonical account list changes', () => {
        const { result } = renderHook(() => useApiBase());

        const repairedAccounts = [realAccount, demoAccount, { ...realAccount, loginid: 'CR456' }];
        authSessionMock.getStoredAccounts.mockReturnValue(repairedAccounts);
        authSessionMock.getAuthInfo.mockReturnValue({
            accountId: 'CR456',
            accessToken: 'token',
            appId: 'app-id',
        });

        act(() => {
            authChangeHandler?.();
        });

        expect(result.current.accountList).toEqual(repairedAccounts);
        // The current selection is still present in the refreshed list, so it
        // must not be yanked away from the user.
        expect(result.current.activeLoginid).toBe('CR123');
    });

    it('does not select an active account that is not in the stored account list', () => {
        authSessionMock.getStoredAccounts.mockReturnValue([realAccount]);
        authSessionMock.getAuthInfo.mockReturnValue({
            accountId: 'CR999',
            accessToken: 'token',
            appId: 'app-id',
        });

        const { result } = renderHook(() => useApiBase());

        expect(result.current.accountList).toEqual([realAccount]);
        expect(result.current.activeLoginid).toBe('');
    });

    it('stays empty when no canonical accounts are stored', () => {
        authSessionMock.getStoredAccounts.mockReturnValue([]);
        authSessionMock.getAuthInfo.mockReturnValue({ accountId: null, accessToken: null, appId: 'app-id' });

        const { result } = renderHook(() => useApiBase());

        expect(result.current.accountList).toEqual([]);
        expect(result.current.activeLoginid).toBe('');
    });
});
