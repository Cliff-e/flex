import { act, render } from '@testing-library/react';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { EventBus } from '@/utils/EventBus';
import CoreStoreProvider from '../CoreStoreProvider';

jest.mock('@/external/bot-skeleton', () => ({
    api_base: { api: null },
}));

jest.mock('@/hooks/auth/useOauth2', () => ({
    useOauth2: () => ({ oAuthLogout: jest.fn() }),
}));

jest.mock('@/hooks/useApiBase', () => ({
    useApiBase: jest.fn(),
}));

jest.mock('@/hooks/useStore', () => ({
    useStore: jest.fn(),
}));

jest.mock('@/utils/AuthSessionManager', () => ({
    AuthSessionManager: {
        isAuthorized: jest.fn(() => true),
    },
}));

jest.mock('@/components/shared', () => ({
    getDecimalPlaces: () => 2,
    toMoment: () => ({}),
}));

jest.mock('@/components/shared/constants/form-error-messages', () => ({
    FORM_ERROR_MESSAGES: () => ({}),
}));

jest.mock('@/components/shared/utils/validation/declarative-validation-rules', () => ({
    initFormErrorMessages: jest.fn(),
}));

const useApiBaseMock = useApiBase as unknown as jest.Mock;
const useStoreMock = useStore as unknown as jest.Mock;
const authSessionMock = AuthSessionManager as unknown as { isAuthorized: jest.Mock };

const account = (loginid: string, extra: Record<string, unknown> = {}) => ({
    loginid,
    currency: 'USD',
    is_virtual: 0,
    is_disabled: 0,
    landing_company_name: 'svg',
    ...extra,
});

type MockClient = {
    all_accounts_balance: any;
    currency: string;
    balance: string;
    is_logged_in: boolean;
    accounts: Record<string, unknown>;
    setAllAccountsBalance: jest.Mock;
    setBalance: jest.Mock;
    setCurrency: jest.Mock;
    setLoginId: jest.Mock;
    setAccountList: jest.Mock;
    setIsLoggedIn: jest.Mock;
    setAccountSettings: jest.Mock;
    setAccountStatus: jest.Mock;
    setWebsiteStatus: jest.Mock;
    setLandingCompany: jest.Mock;
    logout: jest.Mock;
};

const createClient = (): MockClient => {
    const client = {
        all_accounts_balance: null,
        currency: 'USD',
        balance: '0',
        is_logged_in: true,
        accounts: {},
        setBalance: jest.fn(),
        setCurrency: jest.fn(),
        setLoginId: jest.fn(),
        setAccountList: jest.fn(),
        setIsLoggedIn: jest.fn(),
        setAccountSettings: jest.fn(),
        setAccountStatus: jest.fn(),
        setWebsiteStatus: jest.fn(),
        setLandingCompany: jest.fn(),
        logout: jest.fn(),
    } as unknown as MockClient;

    client.setAllAccountsBalance = jest.fn((value: any) => {
        client.all_accounts_balance = value;
    });

    return client;
};

const mockApiBaseState = (activeLoginid: string, accountList = [account('CR1'), account('CR2')]) => {
    useApiBaseMock.mockReturnValue({
        isAuthorizing: false,
        isAuthorized: false,
        isLoggedIn: true,
        connectionStatus: 'unknown',
        accountList,
        activeLoginid,
        authData: null,
    });
};

const renderProvider = (client: MockClient) => {
    useStoreMock.mockReturnValue({
        client,
        common: { setCurrentLanguage: jest.fn(), setServerTime: jest.fn() },
    });

    return render(
        <CoreStoreProvider>
            <div data-testid='child' />
        </CoreStoreProvider>
    );
};

describe('CoreStoreProvider balance synchronisation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
        (authSessionMock.isAuthorized as jest.Mock).mockReturnValue(true);
        mockApiBaseState('CR1');
    });

    it('seeds the authorize balance under the account it belongs to', () => {
        const client = createClient();
        const { unmount } = renderProvider(client);

        act(() => {
            EventBus.emit('auth:success', {
                loginid: 'CR1',
                account_list: [],
                balance: 150.25,
                currency: 'USD',
            });
        });

        expect(client.setAllAccountsBalance).toHaveBeenCalled();
        expect(client.all_accounts_balance.accounts.CR1.balance).toBe(150.25);
        expect(client.all_accounts_balance.accounts.CR1.currency).toBe('USD');

        unmount();
    });

    it('ignores a balance push for a different loginid and applies the active account push', () => {
        const client = createClient();
        const { unmount } = renderProvider(client);

        act(() => {
            EventBus.emit('auth:success', { loginid: 'CR1', account_list: [], balance: 100, currency: 'USD' });
        });
        (client.setAllAccountsBalance as jest.Mock).mockClear();

        act(() => {
            EventBus.emit('balance', { loginid: 'CR2', balance: 999, currency: 'USD', id: 'sub-2' });
        });
        expect(client.setAllAccountsBalance).not.toHaveBeenCalled();

        act(() => {
            EventBus.emit('balance', { loginid: 'CR1', balance: 120, currency: 'USD', id: 'sub-1' });
        });
        expect(client.all_accounts_balance.accounts.CR1.balance).toBe(120);

        unmount();
    });

    it('rejects balance pushes while the session is not WS-authorized', () => {
        (authSessionMock.isAuthorized as jest.Mock).mockReturnValue(false);
        const client = createClient();
        const { unmount } = renderProvider(client);

        act(() => {
            EventBus.emit('balance', { loginid: 'CR1', balance: 120, currency: 'USD', id: 'sub-1' });
        });

        expect(client.setAllAccountsBalance).not.toHaveBeenCalled();
        unmount();
    });

    it('does not seed a fabricated balance from an authorize payload without one', () => {
        const client = createClient();
        const { unmount } = renderProvider(client);

        act(() => {
            EventBus.emit('auth:success', { loginid: 'CR1', account_list: [] });
        });

        expect(client.setAllAccountsBalance).not.toHaveBeenCalled();
        unmount();
    });

    it('fills missing balances from the REST snapshot without overwriting live values', () => {
        localStorage.setItem(
            'restAccounts',
            JSON.stringify({
                CR1: { balance: 50, currency: 'USD' },
                CR2: { balance: 100, currency: 'USD' },
            })
        );

        const client = createClient();
        client.all_accounts_balance = { accounts: { CR1: { balance: 75, currency: 'USD' } } };

        const { unmount } = renderProvider(client);

        expect(client.all_accounts_balance.accounts.CR1.balance).toBe(75);
        expect(client.all_accounts_balance.accounts.CR2.balance).toBe(100);

        unmount();
    });

    it('clears the previous account balance when switching to an account with no balance yet', () => {
        const client = createClient();
        client.all_accounts_balance = { accounts: { CR1: { balance: 75, currency: 'USD' } } };

        const { rerender, unmount } = renderProvider(client);

        (client.setBalance as jest.Mock).mockClear();
        mockApiBaseState('CR2');

        act(() => {
            rerender(
                <CoreStoreProvider>
                    <div data-testid='child' />
                </CoreStoreProvider>
            );
        });

        expect(client.setBalance).toHaveBeenCalledWith('');
        expect(client.setCurrency).toHaveBeenCalledWith('USD');

        unmount();
    });
});

