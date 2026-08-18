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
 *
 * `topup_virtual` is applied to whichever account the WS connection is
 * currently *authorized as* (api_base.account_id) — it is not scoped by the
 * `loginid` argument. If the account switch to this demo account hasn't
 * finished re-authorizing the WS connection yet (or the switch silently
 * failed), the request lands on the wrong/previous account and Deriv
 * rejects it (e.g. `PermissionDenied` on a real account, or a mismatched
 * loginid). We guard against that instead of sending blind and only
 * discovering the mismatch via a cryptic error.
 */
const resetDemoBalance = async (loginid: string) => {
    const request = { topup_virtual: 1 };
    try {
        const currentAuthorizedLoginid = api_base?.account_id;
        if (currentAuthorizedLoginid && currentAuthorizedLoginid !== loginid) {
            console.error('[demo-accounts] resetDemoBalance account-context mismatch', {
                requestedLoginid: loginid,
                wsAuthorizedLoginid: currentAuthorizedLoginid,
            });
            throw new Error(
                'Your session is still switching accounts. Please wait a moment and try resetting the balance again.'
            );
        }

        console.log('[demo-accounts] resetDemoBalance request:', {
            request,
            targetLoginid: loginid,
            wsAuthorizedLoginid: currentAuthorizedLoginid,
        });

        const response = (await api_base?.api?.send(request)) as
            | { error?: { code?: string; message?: string; details?: unknown }; topup_virtual?: unknown }
            | undefined;

        console.log('[demo-accounts] resetDemoBalance response:', response);

        if (response?.error) {
            console.error('[demo-accounts] resetDemoBalance failed', {
                request,
                response,
                errorCode: response.error.code,
                errorMessage: response.error.message,
                errorDetails: response.error.details,
                targetLoginid: loginid,
                wsAuthorizedLoginid: currentAuthorizedLoginid,
            });
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
        console.error('[demo-accounts] resetDemoBalance threw', {
            request,
            targetLoginid: loginid,
            error,
            errorCode: (error as { error?: { code?: string } })?.error?.code,
            errorMessage: (error as Error)?.message,
            errorDetails: (error as { error?: { details?: unknown } })?.error?.details,
        });
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
