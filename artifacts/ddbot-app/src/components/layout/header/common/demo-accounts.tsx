import { useState } from 'react';
import clsx from 'clsx';
import { toast } from 'react-toastify';
import { api_base } from '@/external/bot-skeleton';
import { useDemoBalanceReset } from '@/hooks/useDemoBalanceReset';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { refreshBalancesFromRest } from '@/utils/balance-refresh';
import { localize } from '@deriv-com/translations';
import { AccountSwitcher as UIAccountSwitcher } from '@deriv-com/ui';
import AccountSwitcherFooter from './account-swticher-footer';
import { TDemoAccounts } from './types';
import { AccountSwitcherDivider, convertCommaValue } from './utils';

const DemoAccounts = ({
    tabs_labels,
    modifiedVRTCRAccountList,
    switchAccount,
    isVirtual,
    activeLoginId,
    oAuthLogout,
    is_logging_out,
}: TDemoAccounts) => {
    const { reset, is_resetting } = useDemoBalanceReset();
    const [resettingLoginid, setResettingLoginid] = useState<string | null>(null);

    const handleReset = async (loginid: string) => {
        if (is_resetting) return;
        setResettingLoginid(loginid);
        const ok = await reset(loginid);
        setResettingLoginid(null);

        if (!ok) {
            toast.error(localize('Could not reset demo balance. Please try again.'));
            return;
        }

        toast.success(localize('Your demo balance has been reset.'));

        // Refresh the displayed balance from the authoritative source. The
        // helper is guarded (only writes when this account is still active and
        // authorized); fall back to a WS balance snapshot if the REST backend
        // is unavailable.
        const accessToken = AuthSessionManager.getAuthInfo().accessToken ?? '';
        const result = await refreshBalancesFromRest(accessToken, loginid);
        if (!result) {
            await api_base.requestBalanceSnapshot();
        }
    };

    return (
        <>
            <UIAccountSwitcher.AccountsPanel
                isOpen
                title={localize('Deriv account')}
                className='account-switcher-panel'
                key={tabs_labels.demo.toLowerCase()}
            >
                {modifiedVRTCRAccountList &&
                    modifiedVRTCRAccountList.map(account => {
                        const isCurrent = isVirtual && activeLoginId === account.loginid;
                        const isThisResetting = resettingLoginid === String(account.loginid);
                        const showReset = isCurrent && !isThisResetting && convertCommaValue(account.balance) !== 10000;
                        const displayAccount = isThisResetting
                            ? { ...account, balance: localize('Resetting'), currency: '' }
                            : account;

                        return (
                            <span
                                className={clsx('account-switcher__item', {
                                    'account-switcher__item--disabled': account.is_disabled,
                                })}
                                key={account.loginid}
                            >
                                <UIAccountSwitcher.AccountsItem
                                    account={displayAccount}
                                    onSelectAccount={() => {
                                        if (!account.is_disabled) switchAccount(account.loginid);
                                    }}
                                    onResetBalance={
                                        showReset ? () => handleReset(String(account.loginid)) : undefined
                                    }
                                />
                            </span>
                        );
                    })}
            </UIAccountSwitcher.AccountsPanel>
            <AccountSwitcherDivider />
            <AccountSwitcherFooter
                loginid={activeLoginId}
                oAuthLogout={oAuthLogout}
                is_logging_out={is_logging_out}
                type='demo'
            />
        </>
    );
};

export default DemoAccounts;
