import { renderHook } from '@testing-library/react';
import { useApiBase } from '@/hooks/useApiBase';
import useActiveAccount from '../useActiveAccount';

jest.mock('@/hooks/useApiBase', () => ({
    useApiBase: jest.fn(),
}));

jest.mock('@/components/currency/currency-icon', () => ({
    CurrencyIcon: () => <span data-testid='currency-icon' />,
}));

const useApiBaseMock = useApiBase as unknown as jest.Mock;

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

describe('useActiveAccount', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const mockAccounts = (accountList: unknown[], activeLoginid: string) => {
        useApiBaseMock.mockReturnValue({ accountList, activeLoginid });
    };

    it('returns the selected real account with its actual balance and currency', () => {
        mockAccounts([realAccount, demoAccount], 'CR123');

        const { result } = renderHook(() =>
            useActiveAccount({
                allBalanceData: {
                    accounts: {
                        CR123: { balance: 1234.56, currency: 'USD' },
                        DOT90004580: { balance: 10000, currency: 'USD' },
                    },
                } as any,
            })
        );

        expect(result.current.data?.loginid).toBe('CR123');
        expect(result.current.data?.balance).toBe('1,234.56');
        expect(result.current.data?.currency).toBe('USD');
        expect(result.current.data?.currencyLabel).toBe('USD');
        expect(result.current.data?.isVirtual).toBe(false);
    });

    it('labels a demo account as Demo, not by its loginid prefix', () => {
        mockAccounts([realAccount, demoAccount], 'DOT90004580');

        const { result } = renderHook(() =>
            useActiveAccount({
                allBalanceData: { accounts: { DOT90004580: { balance: 10000, currency: 'USD' } } } as any,
            })
        );

        expect(result.current.data?.loginid).toBe('DOT90004580');
        expect(result.current.data?.currencyLabel).toBe('Demo');
        expect(result.current.data?.isVirtual).toBe(true);
        expect(result.current.data?.balance).toBe('10,000.00');
    });

    it('falls back to the balance carried by the account metadata', () => {
        mockAccounts([{ ...realAccount, balance: 42.5 }], 'CR123');

        const { result } = renderHook(() => useActiveAccount({ allBalanceData: null }));

        expect(result.current.data?.balance).toBe('42.50');
    });

    it('never fabricates a zero balance when the balance is unknown', () => {
        mockAccounts([realAccount], 'CR123');

        const { result } = renderHook(() => useActiveAccount({ allBalanceData: null }));

        expect(result.current.data?.balance).toBe('—');
        expect(result.current.data?.balance).not.toBe('0');
    });

    it('returns undefined when the active loginid is not in the account list', () => {
        mockAccounts([realAccount], 'CR999');

        const { result } = renderHook(() => useActiveAccount({ allBalanceData: null }));

        expect(result.current.data).toBeUndefined();
    });
});
