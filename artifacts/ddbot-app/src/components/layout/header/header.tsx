import { useCallback } from 'react';
import clsx from 'clsx';
import { observer } from 'mobx-react-lite';
import PWAInstallButton from '@/components/pwa-install-button';
import { standalone_routes } from '@/components/shared';
import Button from '@/components/shared_ui/button';
import useActiveAccount from '@/hooks/api/account/useActiveAccount';
import { useOauth2 } from '@/hooks/auth/useOauth2';
import { useFirebaseCountriesConfig } from '@/hooks/firebase/useFirebaseCountriesConfig';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import useTMB from '@/hooks/useTMB';
import { AccountModeController } from '@/utils/AccountModeController';
import { clearAuthData } from '@/utils/auth-utils';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { StandaloneCircleUserRegularIcon } from '@deriv/quill-icons/Standalone';
import { Localize, useTranslations } from '@deriv-com/translations';
import { Header, useDevice, Wrapper } from '@deriv-com/ui';
import { Tooltip } from '@deriv-com/ui';
import { AppLogo } from '../app-logo';
import AccountsInfoLoader from './account-info-loader';
import AccountSwitcher from './account-switcher';
import MenuItems from './menu-items';
import MobileMenu from './mobile-menu';
import PlatformSwitcher from './platform-switcher';
import './header.scss';

type TAppHeaderProps = {
    isAuthenticating?: boolean;
};

const AppHeader = observer(({ isAuthenticating }: TAppHeaderProps) => {
    const { isDesktop } = useDevice();
    const { isAuthorizing, activeLoginid, isLoggedIn } = useApiBase();
    const { client } = useStore() ?? {};

    const { data: activeAccount } = useActiveAccount({ allBalanceData: client?.all_accounts_balance });
    const { accounts, getCurrency, is_virtual } = client ?? {};
    const has_wallet = Object.keys(accounts ?? {}).some(id => accounts?.[id].account_category === 'wallet');

    const currency = getCurrency?.();
    const { localize } = useTranslations();

    const { isSingleLoggingIn } = useOauth2();

    const { hubEnabledCountryList } = useFirebaseCountriesConfig();
    const { onRenderTMBCheck, isTmbEnabled } = useTMB();
    const is_tmb_enabled = isTmbEnabled() || window.is_tmb_enabled === true;

    const renderAccountSection = useCallback(() => {
        // Phase 3 fix: use AuthSessionManager canonical state as the single source
        // of truth for login/logout visibility. Never show Login/Sign Up when a
        // valid authenticated session exists — even if WS auth hasn't completed yet.
        //
        // Rendering priority:
        //   1. Explicit loading states (initialising, WS authorising, SSO in flight)
        //   2. WS authorized — show full account section (activeLoginid populated)
        //   3. Canonical auth exists but WS not yet done — show interim loader
        //      (prevents the Login/Sign Up flash while authorizeAndSubscribe() runs)
        //   4. Truly logged-out — show Login + Sign Up buttons
        const hasRestAuth = AuthSessionManager.isAuthenticated();
        if (isAuthenticating || isAuthorizing || (isSingleLoggingIn && !is_tmb_enabled && !hasRestAuth)) {
            return <AccountsInfoLoader isLoggedIn isMobile={!isDesktop} speed={3} />;
        } else if (activeLoginid) {
            // WS authorize() succeeded — full account switcher
            return (
                <div className='app-header__logged-in-section'>
                    {/* <CustomNotifications /> */}

                    {isDesktop &&
                        (has_wallet ? (
                            <Button
                                className='manage-funds-button'
                                has_effect
                                text={localize('Manage funds')}
                                onClick={() => {
                                    let redirect_url = new URL(standalone_routes.wallets_transfer);
                                    const is_hub_enabled_country = hubEnabledCountryList.includes(
                                        client?.residence || ''
                                    );
                                    if (is_hub_enabled_country) {
                                        redirect_url = new URL(standalone_routes.recent_transactions);
                                    }
                                    if (is_virtual) {
                                        redirect_url.searchParams.set('account', 'demo');
                                    } else if (currency) {
                                        redirect_url.searchParams.set('account', currency);
                                    }
                                    window.location.assign(redirect_url.toString());
                                }}
                                primary
                            />
                        ) : (
                            <Button
                                primary
                                onClick={() => {
                                    const redirect_url = new URL(standalone_routes.cashier_deposit);
                                    if (currency) {
                                        redirect_url.searchParams.set('account', currency);
                                    }
                                    window.location.assign(redirect_url.toString());
                                }}
                                className='deposit-button'
                            >
                                {localize('Deposit')}
                            </Button>
                        ))}

                    <AccountSwitcher activeAccount={activeAccount} />

                    {isDesktop &&
                        (() => {
                            let redirect_url = new URL(standalone_routes.personal_details);
                            const is_hub_enabled_country = hubEnabledCountryList.includes(client?.residence || '');

                            if (has_wallet && is_hub_enabled_country) {
                                redirect_url = new URL(standalone_routes.account_settings);
                            }
                            // Check if the account is a demo account
                            // Use the URL parameter to determine if it's a demo account, as this will update when the account changes
                            const urlParams = new URLSearchParams(window.location.search);
                            const account_param = urlParams.get('account');
                            const is_virtual = client?.is_virtual || account_param === 'demo';

                            if (is_virtual) {
                                // For demo accounts, set the account parameter to 'demo'
                                redirect_url.searchParams.set('account', 'demo');
                            } else if (currency) {
                                // For real accounts, set the account parameter to the currency
                                redirect_url.searchParams.set('account', currency);
                            }
                            return (
                                <Tooltip
                                    as='a'
                                    href={redirect_url.toString()}
                                    tooltipContent={localize('Manage account settings')}
                                    tooltipPosition='bottom'
                                    className='app-header__account-settings'
                                >
                                    <StandaloneCircleUserRegularIcon className='app-header__profile_icon' />
                                </Tooltip>
                            );
                        })()}
                </div>
            );
        } else if (isLoggedIn) {
            // Canonical auth exists (token + loginid in storage) but WS authorize()
            // hasn't completed yet. Show a loading indicator rather than Login/Sign Up —
            // this prevents the flash of logged-out UI while authorizeAndSubscribe() runs.
            return <AccountsInfoLoader isLoggedIn isMobile={!isDesktop} speed={3} />;
        } else {
            // [HEADER] rendering Login button
            console.log('[HEADER] rendering Login button');
            return (
                <div className='auth-actions'>
                    <Button
                        tertiary
                        onClick={async () => {
                            clearAuthData(false);
                            const getQueryParams = new URLSearchParams(window.location.search);
                            const currency = getQueryParams.get('account') ?? '';

                            try {
                                // All authentication flows through AccountModeController.
                                // fromLoginButton:true marks this as an explicit user action.
                                await AccountModeController.enter({
                                    fromLoginButton: true,
                                    isTmbEnabled,
                                    onRenderTMBCheck,
                                    currency: currency || sessionStorage.getItem('query_param_currency') || 'USD',
                                });
                            } catch (error) {
                                // eslint-disable-next-line no-console
                                console.error(error);
                            }
                        }}
                    >
                        <Localize i18n_default_text='Log in' />
                    </Button>
                    <Button
                        primary
                        onClick={() => {
                            window.open(standalone_routes.signup);
                        }}
                    >
                        <Localize i18n_default_text='Sign up' />
                    </Button>
                </div>
            );
        }
    }, [
        isAuthenticating,
        isAuthorizing,
        isSingleLoggingIn,
        isDesktop,
        activeLoginid,
        isLoggedIn,
        standalone_routes,
        client,
        has_wallet,
        currency,
        localize,
        activeAccount,
        is_virtual,
        onRenderTMBCheck,
        is_tmb_enabled,
    ]);

    if (client?.should_hide_header) return null;
    return (
        <Header
            className={clsx('app-header', {
                'app-header--desktop': isDesktop,
                'app-header--mobile': !isDesktop,
            })}
        >
            <Wrapper variant='left'>
                <AppLogo />
                <MobileMenu />
                {isDesktop && <MenuItems.TradershubLink />}
                {isDesktop && <MenuItems />}
                {isDesktop && <PlatformSwitcher />}
            </Wrapper>
            <Wrapper variant='right'>
                {!isDesktop && <PWAInstallButton variant='primary' size='medium' />}
                {renderAccountSection()}
            </Wrapper>
            {/* <PWAInstallModalTest /> */}
        </Header>
    );
});

export default AppHeader;
