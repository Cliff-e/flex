import React, { useEffect } from 'react';
import { lazy, Suspense, useMemo } from 'react';
import { observer } from 'mobx-react-lite';
import { CurrencyIcon } from '@/components/currency/currency-icon';
import CkkLoader from '@/components/loader/ckk-loader';
import { addComma, getDecimalPlaces } from '@/components/shared';
import Popover from '@/components/shared_ui/popover';
import { api_base } from '@/external/bot-skeleton';
import { useOauth2 } from '@/hooks/auth/useOauth2';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { waitForDomElement } from '@/utils/dom-observer';
import { refreshBalancesFromRest } from '@/utils/balance-refresh';
import { Analytics } from '@deriv-com/analytics';
import { localize } from '@deriv-com/translations';
import { AccountSwitcher as UIAccountSwitcher, useDevice } from '@deriv-com/ui';
import { toast } from 'react-toastify';
import type { Balance } from '@deriv/api-types';
import DemoAccounts from './common/demo-accounts';
import RealAccounts from './common/real-accounts';
import { TAccountSwitcher, TAccountSwitcherProps, TModifiedAccount } from './common/types';
import { LOW_RISK_COUNTRIES } from './utils';
import './account-switcher.scss';

const AccountInfoWallets = lazy(() => import('./wallets/account-info-wallets'));

const tabs_labels = {
    demo: localize('Demo'),
    real: localize('Real'),
};

const RenderAccountItems = ({
    isVirtual,
    modifiedCRAccountList,
    modifiedMFAccountList,
    modifiedVRTCRAccountList,
    switchAccount,
    activeLoginId,
    client,
}: TAccountSwitcherProps) => {
    const { oAuthLogout } = useOauth2({ handleLogout: async () => client.logout(), client });
    const is_low_risk_country = LOW_RISK_COUNTRIES().includes(client.account_settings?.country_code ?? '');
    const is_virtual = !!isVirtual;
    const residence = client.residence;

    useEffect(() => {
        // Update the max-height from the accordion content set from deriv-com/ui
        const parent_container = document.getElementsByClassName('account-switcher-panel')?.[0] as HTMLDivElement;
        if (!isVirtual && parent_container) {
            parent_container.style.maxHeight = '70vh';
            waitForDomElement('.deriv-accordion__content', parent_container)?.then((accordionElement: unknown) => {
                const element = accordionElement as HTMLDivElement;
                if (element) {
                    element.style.maxHeight = '70vh';
                }
            });
        }
    }, [isVirtual]);

    if (is_virtual) {
        return (
            <>
                <DemoAccounts
                    modifiedVRTCRAccountList={modifiedVRTCRAccountList as TModifiedAccount[]}
                    switchAccount={switchAccount}
                    activeLoginId={activeLoginId}
                    isVirtual={is_virtual}
                    tabs_labels={tabs_labels}
                    oAuthLogout={oAuthLogout}
                    is_logging_out={client.is_logging_out}
                />
            </>
        );
    } else {
        return (
            <RealAccounts
                modifiedCRAccountList={modifiedCRAccountList as TModifiedAccount[]}
                modifiedMFAccountList={modifiedMFAccountList as TModifiedAccount[]}
                switchAccount={switchAccount}
                isVirtual={is_virtual}
                tabs_labels={tabs_labels}
                is_low_risk_country={is_low_risk_country}
                oAuthLogout={oAuthLogout}
                loginid={activeLoginId}
                is_logging_out={client.is_logging_out}
                upgradeable_landing_companies={client?.landing_companies?.all_company ?? null}
                residence={residence}
            />
        );
    }
};

const AccountSwitcher = observer(({ activeAccount }: TAccountSwitcher) => {
    const { isDesktop } = useDevice();
    const { accountList } = useApiBase();
    const { ui, run_panel, client } = useStore();
    const { accounts } = client;
    const { toggleAccountsDialog, is_accounts_switcher_on, account_switcher_disabled_message } = ui;
    const { is_stop_button_visible } = run_panel;
    const has_wallet = Object.keys(accounts).some(id => accounts[id].account_category === 'wallet');

    const modifiedAccountList = useMemo(() => {
        return accountList?.map(account => {
            const accountBalance =
                client.all_accounts_balance?.accounts?.[account?.loginid]?.balance ??
                (account as { balance?: number }).balance;
            // addComma(undefined) returns "0" — guard before calling it so an
            // unknown balance is shown as unknown, never as a fabricated zero.
            const formattedBalance =
                accountBalance != null && Number.isFinite(Number(accountBalance))
                    ? addComma(Number(accountBalance).toFixed(getDecimalPlaces(account.currency)))
                    : undefined;

            return {
                ...account,
                balance: formattedBalance ?? '—',
                currencyLabel: account?.is_virtual
                    ? tabs_labels.demo
                    : (client.website_status?.currencies_config?.[account?.currency]?.name ?? account?.currency),
                icon: (
                    <CurrencyIcon
                        currency={account?.currency?.toLowerCase()}
                        isVirtual={Boolean(account?.is_virtual)}
                    />
                ),
                isVirtual: Boolean(account?.is_virtual),
                isActive: account?.loginid === activeAccount?.loginid,
            };
        });
    }, [
        accountList,
        client.all_accounts_balance?.accounts,
        client.website_status?.currencies_config,
        activeAccount?.loginid,
    ]);
    // Split real (non-virtual) accounts by landing company rather than
    // matching substrings in loginid. The new Deriv trading API can assign
    // real-account loginids that don't contain the legacy "CR"/"MF" prefixes,
    // which made these lists (and therefore the Real tab's switch targets)
    // silently drop accounts — the same prefix-matching bug already fixed for
    // the Demo tab's isVirtual-based list below.
    const modifiedMFAccountList = useMemo(() => {
        return modifiedAccountList?.filter(account => !account?.isVirtual && account?.landing_company_name === 'maltainvest') ?? [];
    }, [modifiedAccountList]);

    const modifiedCRAccountList = useMemo(() => {
        return (
            modifiedAccountList?.filter(
                account => !account?.isVirtual && account?.landing_company_name !== 'maltainvest'
            ) ?? []
        );
    }, [modifiedAccountList]);

    const modifiedVRTCRAccountList = useMemo(() => {
        // Use the explicit isVirtual flag (derived from is_virtual metadata) rather than
        // inferring account type from the loginid prefix. The loginid prefix approach
        // fails when the demo account ID does not start with "VRT" (e.g. newer Deriv formats).
        return modifiedAccountList?.filter(account => account?.isVirtual) ?? [];
    }, [modifiedAccountList]);

    const switchAccount = async (loginId: number) => {
        if (loginId.toString() === activeAccount?.loginid) return;
        const loginIdStr = loginId.toString();

        const account_type =
            loginId
                .toString()
                .match(/[a-zA-Z]+/g)
                ?.join('') || '';

        Analytics.setAttributes({
            account_type,
        });

        // Delegate to the transactional switch in api-base — it serializes rapid
        // taps (last selection wins), authorizes the target account, and only
        // persists the switch after success. The header loader is driven by
        // isAuthorizing inside api-base.
        const result = await api_base?.switchAccount(loginIdStr);
        if (!result?.ok) {
            toast.error(localize(result?.message || 'Failed to switch account. Please try again.'));
            return;
        }

        // Refresh balances for the now-active account (guarded inside the helper).
        const accessToken = AuthSessionManager.getAuthInfo().accessToken ?? '';
        refreshBalancesFromRest(accessToken, loginIdStr).then(balances => {
            if (!balances) return;
            client.setAllAccountsBalance({
                balance: Number(balances.activeBalance),
                currency: balances.activeCurrency,
                loginid: loginIdStr,
                accounts: balances.allAccounts as unknown as Balance['accounts'],
            });
        });

        const search_params = new URLSearchParams(window.location.search);
        const selected_account = modifiedAccountList.find(acc => acc.loginid === loginIdStr);
        if (!selected_account) return;
        const account_param = selected_account.is_virtual ? 'demo' : selected_account.currency;
        search_params.set('account', account_param);
        sessionStorage.setItem('query_param_currency', account_param);
        window.history.pushState({}, '', `${window.location.pathname}?${search_params.toString()}`);
    };

    return (
        activeAccount &&
        (has_wallet ? (
            <Suspense fallback={<CkkLoader />}>
                <AccountInfoWallets is_dialog_on={is_accounts_switcher_on} toggleDialog={toggleAccountsDialog} />
            </Suspense>
        ) : (
            <Popover
                className='run-panel__info'
                classNameBubble='run-panel__info--bubble'
                alignment='bottom'
                message={account_switcher_disabled_message}
                zIndex='5'
            >
                <UIAccountSwitcher
                    activeAccount={activeAccount}
                    isDisabled={is_stop_button_visible}
                    tabsLabels={tabs_labels}
                    modalContentStyle={{
                        content: {
                            top: isDesktop ? '30%' : '50%',
                            borderRadius: '10px',
                        },
                    }}
                >
                    <UIAccountSwitcher.Tab title={tabs_labels.real}>
                        <RenderAccountItems
                            modifiedCRAccountList={modifiedCRAccountList as TModifiedAccount[]}
                            modifiedMFAccountList={modifiedMFAccountList as TModifiedAccount[]}
                            switchAccount={switchAccount}
                            activeLoginId={activeAccount?.loginid}
                            client={client}
                        />
                    </UIAccountSwitcher.Tab>
                    <UIAccountSwitcher.Tab title={tabs_labels.demo}>
                        <RenderAccountItems
                            modifiedVRTCRAccountList={modifiedVRTCRAccountList as TModifiedAccount[]}
                            switchAccount={switchAccount}
                            isVirtual
                            activeLoginId={activeAccount?.loginid}
                            client={client}
                        />
                    </UIAccountSwitcher.Tab>
                </UIAccountSwitcher>
            </Popover>
        ))
    );
});

export default AccountSwitcher;
