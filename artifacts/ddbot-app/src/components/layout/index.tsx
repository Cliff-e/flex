import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import Cookies from 'js-cookie';
import { observer } from 'mobx-react-lite';
import { Outlet } from 'react-router-dom';
import PWAUpdateNotification from '@/components/pwa-update-notification';
import { api_base } from '@/external/bot-skeleton';
import { useOfflineDetection } from '@/hooks/useOfflineDetection';
import { useStore } from '@/hooks/useStore';
import useTMB from '@/hooks/useTMB';
import { AccountModeController } from '@/utils/AccountModeController';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { useDevice } from '@deriv-com/ui';
import { crypto_currencies_display_order, fiat_currencies_display_order } from '../shared';
import Footer from './footer';
import AppHeader from './header';
import Body from './main-body';
import './layout.scss';

const Layout = observer(() => {
    const { isDesktop } = useDevice();
    const { isOnline } = useOfflineDetection();
    const store = useStore();
    const is_quick_strategy_active = store?.quick_strategy?.is_open;

    const isCallbackPage = window.location.pathname === '/auth/callback';
    const { onRenderTMBCheck, is_tmb_enabled: tmb_enabled_from_hook, isTmbEnabled } = useTMB();
    const is_tmb_enabled = useMemo(
        () => window.is_tmb_enabled === true || tmb_enabled_from_hook,
        [tmb_enabled_from_hook]
    );

    const isLoggedInCookie = Cookies.get('logged_state') === 'true';
    const isEndpointPage = window.location.pathname.includes('endpoint');
    const checkClientAccount = JSON.parse(localStorage.getItem('clientAccounts') ?? '{}');
    const getQueryParams = new URLSearchParams(window.location.search);
    const currency = getQueryParams.get('account') ?? '';
    const accountsList = JSON.parse(localStorage.getItem('accountsList') ?? '{}');
    const isClientAccountsPopulated = Object.keys(accountsList).length > 0;
    const ifClientAccountHasCurrency =
        Object.values(checkClientAccount).some((account: any) => account.currency === currency) ||
        currency === 'demo' ||
        currency === '';
    const [clientHasCurrency, setClientHasCurrency] = useState(ifClientAccountHasCurrency);
    const [isAuthenticating, setIsAuthenticating] = useState(true); // Start with true to prevent flashing

    // Expose setClientHasCurrency to window for global access
    useEffect(() => {
        (window as any).setClientHasCurrency = setClientHasCurrency;

        return () => {
            delete (window as any).setClientHasCurrency;
        };
    }, []);

    const validCurrencies = [...fiat_currencies_display_order, ...crypto_currencies_display_order];
    const query_currency = (getQueryParams.get('account') ?? '')?.toUpperCase();
    const isCurrencyValid = validCurrencies.includes(query_currency);
    const api_accounts: any[][] = [];
    let subscription: { unsubscribe: () => void };

    const validateApiAccounts = ({ data }: any) => {
        if (data.msg_type === 'authorize') {
            const account_list = data?.authorize?.account_list || [];
            const account_list_filter = account_list.filter((acc: any) => acc.is_disabled === 0);
            api_accounts.push(account_list_filter || []);

            // The active access token — used for PKCE flows where all accounts share one JWT.
            const activeToken = localStorage.getItem('authToken') ?? '';

            // Re-read accountsList freshly (may have been written by callback page after initial render).
            const freshAccountsList: Record<string, string> = JSON.parse(
                localStorage.getItem('accountsList') ?? '{}'
            );
            const freshClientAccounts: Record<string, any> = JSON.parse(
                localStorage.getItem('clientAccounts') ?? '{}'
            );

            // If WS authorize returned accounts that are missing from our stored maps,
            // add them using the current access token instead of triggering re-authentication.
            // This handles the case where the REST accounts fetch returned fewer accounts
            // than the WS authorize response.
            let repaired = false;
            for (const acc of account_list_filter) {
                if (acc.loginid && !freshAccountsList[acc.loginid] && activeToken) {
                    freshAccountsList[acc.loginid] = activeToken;
                    freshClientAccounts[acc.loginid] = {
                        loginid: acc.loginid,
                        token: activeToken,
                        currency: acc.currency || '',
                        account_type: acc.is_virtual ? 'demo' : 'real',
                    };
                    repaired = true;
                }
            }
            if (repaired) {
                AuthSessionManager.setAccounts(freshAccountsList, freshClientAccounts);
            }

            const allCurrencies = new Set(Object.values(freshClientAccounts).map((acc: any) => acc.currency));
            const accounts = api_accounts.flat();

            const hasMissingCurrency = accounts.some((item: any) => {
                if (!allCurrencies.has(item.currency)) {
                    sessionStorage.setItem('query_param_currency', item.currency);
                    return true;
                }
                return false;
            });

            // After repair above, check again — no missing tokens should remain.
            const hasMissingToken = account_list_filter.some(
                (acc: any) => acc.loginid && !freshAccountsList[acc.loginid]
            );

            if (hasMissingCurrency || hasMissingToken) {
                setClientHasCurrency(false);
            } else {
                const account_list_ =
                    account_list_filter?.find((acc: { currency: string }) => acc.currency === currency) ||
                    account_list_filter?.[0];

                let session_storage_currency =
                    sessionStorage.getItem('query_param_currency') || account_list_?.currency || 'USD';

                session_storage_currency = `account=${session_storage_currency}`;
                setClientHasCurrency(true);
                if (!new URLSearchParams(window.location.search).has('account')) {
                    window.history.pushState({}, '', `${window.location.pathname}?${session_storage_currency}`);
                }
            }

            if (subscription) {
                subscription?.unsubscribe();
            }
        }
    };

    useEffect(() => {
        if (isCurrencyValid && api_base.api) {
            // Subscribe to the onMessage event
            const is_valid_currency = currency && validCurrencies.includes(currency.toUpperCase());
            if (!is_valid_currency) return;
            subscription = api_base.api.onMessage().subscribe(validateApiAccounts);
        }
    }, []);

    useEffect(() => {
        // Always set the currency in session storage, even if the user is not logged in
        // This ensures the currency is available on the callback page
        setIsAuthenticating(true);
        if (currency) {
            sessionStorage.setItem('query_param_currency', currency);
        }

        // FIX: Only redirect to OAuth when the user previously logged in (cookie is set)
        // AND their session data is now missing or incomplete.
        //
        // Before: `checkOIDCEnabledWithMissingAccount` fired for ANY user whose
        // accountsList was empty — including guests who never logged in — because
        // `clientHasCurrency` defaults to false when localStorage is empty.
        // This caused guests to be bounced to Deriv OAuth on page load, blocking
        // charts and market data before they even rendered.
        //
        // After: both conditions require `isLoggedInCookie === true`, which means
        // the user intentionally logged in before. Guests (no cookie) see the full
        // app immediately with public market data working.
        const checkOIDCEnabledWithMissingAccount =
            isLoggedInCookie && !isEndpointPage && !isCallbackPage && !clientHasCurrency;
        const shouldAuthenticate =
            (isLoggedInCookie && !isClientAccountsPopulated && !isEndpointPage && !isCallbackPage) ||
            checkOIDCEnabledWithMissingAccount;

        // Skip authentication when offline
        if (!isOnline) {
            console.log('[Layout] Offline detected, skipping authentication');
            setIsAuthenticating(false);
            setClientHasCurrency(true); // Allow access in offline mode
            return;
        }

        // All authentication is routed through AccountModeController.
        // Behavior is unchanged (Checkpoint 1). The startup call here
        // will be REMOVED in Checkpoint 3 — auth will only begin from
        // the Login button after that point.
        AccountModeController.enter({
            fromLoginButton: false,
            setIsAuthenticating,
            isTmbEnabled,
            onRenderTMBCheck,
            shouldAuthenticate,
            currency: currency || sessionStorage.getItem('query_param_currency') || 'USD',
        }).catch(err => {
            // eslint-disable-next-line no-console
            console.error('[Layout] Authentication error:', err);
        }).finally(() => {
            setIsAuthenticating(false);
        });
    }, [
        isLoggedInCookie,
        isClientAccountsPopulated,
        isEndpointPage,
        isCallbackPage,
        clientHasCurrency,
        tmb_enabled_from_hook,
        onRenderTMBCheck,
        currency,
        is_tmb_enabled,
        isOnline, // Add isOnline to dependencies
    ]);

    // Add offline timeout to prevent infinite authentication
    useEffect(() => {
        if (!isOnline && isAuthenticating) {
            console.log('[Layout] Setting offline timeout for authentication');
            const timeout = setTimeout(() => {
                console.log('[Layout] Offline timeout reached, stopping authentication');
                setIsAuthenticating(false);
                setClientHasCurrency(true);
            }, 2000);

            return () => clearTimeout(timeout);
        }
    }, [isOnline, isAuthenticating]);

    // Add a state to track if initial authentication check is complete
    const [isInitialAuthCheckComplete, setIsInitialAuthCheckComplete] = useState(false);

    // Effect to mark initial auth check as complete after a short delay
    useEffect(() => {
        if (!isAuthenticating && !isInitialAuthCheckComplete) {
            // Wait a bit to ensure all state updates have propagated
            const timer = setTimeout(() => {
                setIsInitialAuthCheckComplete(true);
            }, 500); // Give it enough time to stabilize

            return () => clearTimeout(timer);
        }
    }, [isAuthenticating, isInitialAuthCheckComplete]);

    return (
        <div
            className={clsx('layout', {
                responsive: isDesktop,
                'quick-strategy-active': is_quick_strategy_active && !isDesktop,
            })}
        >
            {!isCallbackPage && <AppHeader isAuthenticating={isAuthenticating || !isInitialAuthCheckComplete} />}
            <Body>
                <Outlet />
            </Body>
            {!isCallbackPage && isDesktop && <Footer />}
            <PWAUpdateNotification />
        </div>
    );
});

export default Layout;
