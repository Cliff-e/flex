import { initSurvicate } from '../public-path';
import { lazy, Suspense } from 'react';
import React from 'react';
import { createBrowserRouter, createRoutesFromElements, Route, RouterProvider } from 'react-router-dom';
import ChunkLoader from '@/components/loader/chunk-loader';
import RoutePromptDialog from '@/components/route-prompt-dialog';
import { crypto_currencies_display_order, fiat_currencies_display_order } from '@/components/shared';
import { useOfflineDetection } from '@/hooks/useOfflineDetection';
import { StoreProvider } from '@/hooks/useStore';
import CallbackPage from '@/pages/callback';
import Endpoint from '@/pages/endpoint';
import { TAuthData } from '@/types/api-types';
import { AccountModeController } from '@/utils/AccountModeController';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { initializeI18n, localize, TranslationProvider } from '@deriv-com/translations';
import CoreStoreProvider from './CoreStoreProvider';
import { AuthReadyProvider } from '@/utils/AuthReadyContext';
import { AuthManager } from '@/utils/AuthManager';
import { PublicMarketSocket } from '@/utils/PublicMarketSocket';
import './app-root.scss';
const Layout = lazy(() => import('../components/layout'));
const AppRoot = lazy(() => import('./app-root'));
const FreeBots = lazy(() => import('../pages/free-bots'));
const AnalysisTool = lazy(() => import('../pages/analysis-tool'));
const AiBots = lazy(() => import('../pages/ai-bots/AiBots'));
// Sync our configured app ID into localStorage so @deriv-com/auth-client
// picks it up for OIDC (it reads 'config.app_id', not VITE_DERIV_APP_ID).
if (import.meta.env.VITE_DERIV_APP_ID) {
    localStorage.setItem('config.app_id', import.meta.env.VITE_DERIV_APP_ID);
}

const { TRANSLATIONS_CDN_URL, R2_PROJECT_NAME, CROWDIN_BRANCH_NAME } = process.env;
const i18nInstance = initializeI18n({
    cdnUrl: `${TRANSLATIONS_CDN_URL}/${R2_PROJECT_NAME}/${CROWDIN_BRANCH_NAME}`,
});

// Simple Suspense wrapper without timeout that causes dark landing page
const SuspenseWrapper = ({ children }: { children: React.ReactNode }) => {
    const { isOnline } = useOfflineDetection();

    const getLoadingMessage = () => {
        if (!isOnline) return localize('Loading offline dashboard...');
        return localize('Please wait while we connect to the server...');
    };

    return <Suspense fallback={<ChunkLoader message={getLoadingMessage()} />}>{children}</Suspense>;
};

const router = createBrowserRouter(
    createRoutesFromElements(
        <Route
            path='/'
            element={
                <SuspenseWrapper>
                    <TranslationProvider defaultLang='EN' i18nInstance={i18nInstance}>
                        <StoreProvider>
                            <RoutePromptDialog />
                            <AuthReadyProvider>
                                <CoreStoreProvider>
                                    <Layout />
                                </CoreStoreProvider>
                            </AuthReadyProvider>
                        </StoreProvider>
                    </TranslationProvider>
                </SuspenseWrapper>
            }
        >
            {/* All child routes will be passed as children to Layout */}
            <Route index element={<AppRoot />} />
            <Route path='endpoint' element={<Endpoint />} />
            <Route path='auth/callback' element={<CallbackPage />} />
            <Route path='free-bots' element={<FreeBots />} />
            <Route path='analysis-tool' element={<AnalysisTool />} />
            <Route path="/ai-bots" element={<AiBots />} />
        </Route>
    )
);

function App() {
    React.useEffect(() => {
        // Connect the public market socket immediately on app load — no auth required.
        // This socket handles all chart/tick data independently of the trading socket.
        PublicMarketSocket.connect().catch(() => {
            // Reconnect is handled internally by PublicMarketSocket on failure
        });

        // Initialize the global auth manager (proactive token refresh).
        // This is safe to call multiple times — it's idempotent.
        AuthManager.init();

        initSurvicate();
        window?.dataLayer?.push({ event: 'page_load' });
        return () => {
            // Clean up the invalid token handler when the component unmounts
            const survicate_box = document.getElementById('survicate-box');
            if (survicate_box) {
                survicate_box.style.display = 'none';
            }
        };
    }, []);

    React.useEffect(() => {
        // ── Canonical-auth gate ──────────────────────────────────────────────
        // Enable account mode whenever a valid access token exists in storage.
        // This replaces the old fragile accountsList + currency-match guard that
        // silently aborted when the /api/auth/accounts fetch had failed or the
        // URL currency didn't match a stored account.
        //
        // We only need the access token here — the loginid is populated either
        // from localStorage (when accounts fetch succeeded) or from the WS
        // authorize() response (when it was missing/pending).
        const { accessToken } = AuthSessionManager.getAuthInfo();
        if (!accessToken) {
            // No credentials at all — stay in public mode.
            return;
        }

        console.log('[App] Canonical access token found — enabling account mode');
        AccountModeController.enableAccountMode();

        // Best-effort: select the right account for the URL currency.
        // This is optional; api_base will authorize with whatever ASM already
        // holds if no match is found here.
        const accounts_list = localStorage.getItem('accountsList');
        const client_accounts = localStorage.getItem('clientAccounts');
        const url_params = new URLSearchParams(window.location.search);
        const account_currency = url_params.get('account');
        const validCurrencies = [...fiat_currencies_display_order, ...crypto_currencies_display_order];
        const is_valid_currency = account_currency && validCurrencies.includes(account_currency?.toUpperCase());

        if (accounts_list && client_accounts) {
            try {
                const parsed_accounts = JSON.parse(accounts_list);
                const parsed_client_accounts = JSON.parse(client_accounts) as TAuthData['account_list'];

                // Handle demo account
                if (account_currency?.toUpperCase() === 'DEMO') {
                    const demo_account = Object.entries(parsed_accounts).find(([key]) => key.startsWith('VR'));
                    if (demo_account) {
                        const [loginid, token] = demo_account;
                        AccountModeController.restoreFromUrl(loginid, String(token));
                        return;
                    }
                }

                // Handle real account with valid currency
                if (account_currency?.toUpperCase() !== 'DEMO' && is_valid_currency) {
                    const real_account = Object.entries(parsed_client_accounts).find(
                        ([loginid, account]) =>
                            !loginid.startsWith('VR') && account.currency.toUpperCase() === account_currency?.toUpperCase()
                    );

                    if (real_account) {
                        const [loginid, account] = real_account;
                        if ('token' in account) {
                            AccountModeController.restoreFromUrl(loginid, String(account?.token));
                            return;
                        }
                    }
                }
            } catch (e) {
                console.warn('[App] Account restore parse error:', e);
            }
        }

        // Fallback: restore with whatever AuthSessionManager already holds.
        // This covers the case where accountsList/clientAccounts were not
        // written (accounts fetch failed on the callback page) or the URL
        // currency didn't match any stored account.
        const { accountId } = AuthSessionManager.getAuthInfo();
        if (accountId) {
            console.log('[App] Restoring from ASM state — loginid:', accountId);
            AccountModeController.restoreFromUrl(accountId, accessToken);
        } else {
            // Token present but no loginid yet (accounts fetch failed on the
            // callback page). WS authorize() will resolve and store the loginid.
            console.log('[App] Token present, no loginid yet — WS authorize() will resolve it');
        }
    }, []);

    return <RouterProvider router={router} />;
}

export default App;
