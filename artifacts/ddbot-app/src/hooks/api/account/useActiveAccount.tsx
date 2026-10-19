import { useMemo } from 'react';
import { CurrencyIcon } from '@/components/currency/currency-icon';
import { addComma, getDecimalPlaces } from '@/components/shared';
import { useApiBase } from '@/hooks/useApiBase';
import { Balance } from '@deriv/api-types';
import { localize } from '@deriv-com/translations';

/** A custom hook that returns the account object for the current active account. */
const useActiveAccount = ({ allBalanceData }: { allBalanceData: Balance | null }) => {
    const { accountList, activeLoginid } = useApiBase();

    const activeAccount = useMemo(
        () => accountList?.find(account => account.loginid === activeLoginid),
        [activeLoginid, accountList]
    );

    const currentBalanceData = allBalanceData?.accounts?.[activeAccount?.loginid ?? ''];

    const modifiedAccount = useMemo(() => {
        if (!activeAccount) return undefined;

        // Prefer the live balance map, then fall back to the balance carried by
        // the authorize/account-list entry so the freshly switched account shows
        // its real balance immediately instead of a stale "0".
        const currency = currentBalanceData?.currency ?? activeAccount?.currency;
        const balanceValue =
            currentBalanceData?.balance ??
            (typeof (activeAccount as { balance?: number }).balance === 'number'
                ? (activeAccount as { balance?: number }).balance
                : undefined);
        // Never coerce an unknown balance to 0 — that silently presents a
        // fabricated amount. addComma(undefined) returns "0", so guard first.
        const formattedBalance =
            balanceValue != null && Number.isFinite(Number(balanceValue))
                ? addComma(Number(balanceValue).toFixed(getDecimalPlaces(currency)))
                : undefined;

        return {
            ...activeAccount,
            balance: formattedBalance ?? '—',
            currencyLabel: activeAccount?.is_virtual ? localize('Demo') : activeAccount?.currency,
            icon: (
                <CurrencyIcon
                    currency={activeAccount?.currency?.toLowerCase()}
                    isVirtual={Boolean(activeAccount?.is_virtual)}
                />
            ),
            isVirtual: Boolean(activeAccount?.is_virtual),
            isActive: activeAccount?.loginid === activeLoginid,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeAccount, activeLoginid, allBalanceData]);

    return {
        /** User's current active account. */
        data: modifiedAccount,
    };
};

export default useActiveAccount;
