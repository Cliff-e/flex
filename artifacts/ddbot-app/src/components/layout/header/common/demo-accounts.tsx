import clsx from 'clsx';
import { toast } from 'react-toastify';
import { api_base } from '@/external/bot-skeleton';
import { refreshBalancesFromRest } from '@/utils/balance-refresh';
import { localize } from '@deriv-com/translations';
import { AccountSwitcher as UIAccountSwitcher } from '@deriv-com/ui';
import AccountSwitcherFooter from './account-swticher-footer';
import { TDemoAccounts } from './types';
import { AccountSwitcherDivider, convertCommaValue } from './utils';

/**
 * Requests a demo-balance top-up and waits for the result instead of firing
 * the request and forgetting about it — the previous fire-and-forget call
 * gave no feedback on failure and never nudged the UI to refresh, so the
 * button appeared to do nothing even when the request actually failed.
 */
const resetDemoBalance = async (loginid: string) => {
    try {
        const response = (await api_base?.api?.send({ topup_virtual: 1 })) as
            | { error?: { message?: string }; topup_virtual?: unknown }
            | undefined;
        if (response?.error) {
            throw new Error(response.error.message || 'Failed to reset demo balance');
        }
        // The WS balance subscription (see api-base.subscribe, `account: 'all'`)
        // normally pushes the updated balance automatically, but fall back to a
        // REST refresh so the UI is guaranteed to reflect the new balance even
        // if that push is delayed or missed.
        const accessToken = localStorage.getItem('authToken') ?? '';
        if (accessToken) {
            await refreshBalancesFromRest(accessToken, loginid);
        }
        toast.success(localize('Your demo balance has been reset.'));
    } catch (error) {
        console.error('[demo-accounts] resetDemoBalance failed:', error);
        toast.error(
            (error as Error)?.message ? localize((error as Error).message) : localize('Failed to reset demo balance.')
        );
    }
};

const DemoAccounts = ({
    tabs_labels,
    modifiedVRTCRAccountList,
    switchAccount,
    isVirtual,
    activeLoginId,
    oAuthLogout,
    is_logging_out,
}: TDemoAccounts) => {
    return (
        <>
            <UIAccountSwitcher.AccountsPanel
                isOpen
                title={localize('Deriv account')}
                className='account-switcher-panel'
                key={tabs_labels.demo.toLowerCase()}
            >
                {modifiedVRTCRAccountList &&
                    modifiedVRTCRAccountList.map(account => (
                        <span
                            className={clsx('account-switcher__item', {
                                'account-switcher__item--disabled': account.is_disabled,
                            })}
                            key={account.loginid}
                        >
                            <UIAccountSwitcher.AccountsItem
                                account={account}
                                onSelectAccount={() => {
                                    if (!account.is_disabled) switchAccount(account.loginid);
                                }}
                                onResetBalance={
                                    isVirtual &&
                                    activeLoginId === account.loginid &&
                                    convertCommaValue(account.balance) !== 10000
                                        ? () => {
                                              resetDemoBalance(String(account.loginid));
                                          }
                                        : undefined
                                }
                            />
                        </span>
                    ))}
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
