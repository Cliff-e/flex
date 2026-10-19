import React from 'react';
import { render, screen } from '@testing-library/react';
import useActiveAccount from '@/hooks/api/account/useActiveAccount';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import AppHeader from '../header';

jest.mock('@deriv-com/ui', () => ({
    Header: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
    Wrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    useDevice: () => ({ isDesktop: true }),
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@deriv/quill-icons/Standalone', () => ({
    StandaloneCircleUserRegularIcon: () => null,
}));

jest.mock('@/hooks/useApiBase', () => ({
    useApiBase: jest.fn(),
}));

jest.mock('@/hooks/useStore', () => ({
    useStore: jest.fn(),
}));

jest.mock('@/hooks/api/account/useActiveAccount', () => ({
    __esModule: true,
    default: jest.fn(),
}));

jest.mock('@/hooks/firebase/useFirebaseCountriesConfig', () => ({
    useFirebaseCountriesConfig: () => ({ hubEnabledCountryList: [] }),
}));

jest.mock('@/components/pwa-install-button', () => () => null);

jest.mock('@/components/layout/app-logo', () => ({
    AppLogo: () => null,
}));

jest.mock('@/components/shared', () => ({
    standalone_routes: {
        wallets_transfer: 'https://example.test/transfer',
        recent_transactions: 'https://example.test/transactions',
        cashier_deposit: 'https://example.test/deposit',
        personal_details: 'https://example.test/details',
        account_settings: 'https://example.test/settings',
        signup: 'https://example.test/signup',
    },
}));

jest.mock('@/components/shared_ui/button', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <button type='button'>{children}</button>,
}));

jest.mock('../account-info-loader', () => () => <div data-testid='accounts-info-loader' />);
jest.mock('../account-switcher', () => () => <div data-testid='account-switcher' />);
jest.mock('../menu-items', () => {
    const MenuItems = () => <div data-testid='menu-items' />;
    return {
        __esModule: true,
        default: Object.assign(MenuItems, { TradershubLink: () => null }),
    };
});
jest.mock('../mobile-menu', () => () => null);
jest.mock('../mobile-theme-toggle', () => () => null);
jest.mock('../platform-switcher', () => () => null);

jest.mock('@/utils/AccountModeController', () => ({
    AccountModeController: { enter: jest.fn() },
}));

jest.mock('@/utils/auth-utils', () => ({
    clearAuthData: jest.fn(),
}));

const useApiBaseMock = useApiBase as unknown as jest.Mock;
const useStoreMock = useStore as unknown as jest.Mock;
const useActiveAccountMock = useActiveAccount as unknown as jest.Mock;

const client = {
    accounts: {},
    getCurrency: () => 'USD',
    is_virtual: false,
    residence: 'gb',
    account_settings: { country_code: 'gb' },
    landing_companies: { all_company: null },
    is_logging_out: false,
    should_hide_header: false,
    logout: jest.fn(),
};

const setup = ({ isAuthorizing, activeLoginid }: { isAuthorizing: boolean; activeLoginid: string }) => {
    useApiBaseMock.mockReturnValue({ isAuthorizing, activeLoginid });
    useStoreMock.mockReturnValue({ client });
    useActiveAccountMock.mockReturnValue({
        data: activeLoginid
            ? {
                  loginid: activeLoginid,
                  currency: 'USD',
                  balance: '100.00',
                  currencyLabel: 'USD',
                  isVirtual: false,
                  icon: null,
              }
            : undefined,
    });

    return render(<AppHeader isAuthenticating={false} />);
};

describe('AppHeader account section', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('shows the loader while the WS authorization is in progress', () => {
        setup({ isAuthorizing: true, activeLoginid: '' });

        expect(screen.getByTestId('accounts-info-loader')).toBeInTheDocument();
        expect(screen.queryByTestId('account-switcher')).not.toBeInTheDocument();
    });

    it('does not leave a permanent placeholder when auth finished without a resolved account', () => {
        setup({ isAuthorizing: false, activeLoginid: '' });

        expect(screen.queryByTestId('accounts-info-loader')).not.toBeInTheDocument();
        expect(screen.getByText('Log in')).toBeInTheDocument();
    });

    it('renders the account switcher once the active account is resolved', () => {
        setup({ isAuthorizing: false, activeLoginid: 'CR123' });

        expect(screen.getByTestId('account-switcher')).toBeInTheDocument();
        expect(screen.queryByTestId('accounts-info-loader')).not.toBeInTheDocument();
    });
});
