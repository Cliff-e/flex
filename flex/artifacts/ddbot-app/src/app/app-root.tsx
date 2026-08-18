import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import ErrorBoundary from '@/components/error-component/error-boundary';
import ErrorComponent from '@/components/error-component/error-component';
import AppSplash from '@/components/loader/AppSplash';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import LandingPage, { PREVIEW_MODE_KEY } from '@/pages/landing/LandingPage';
import { localize } from '@deriv-com/translations';
import './app-root.scss';

const AppContent = lazy(() => import('./app-content'));

const AppRootLoader = () => {
    return <AppSplash message={localize('Initializing...')} />;
};

const ErrorComponentWrapper = observer(() => {
    const { common } = useStore();

    if (!common.error) return null;

    return (
        <ErrorComponent
            header={common.error?.header}
            message={common.error?.message}
            redirect_label={common.error?.redirect_label}
            redirectOnClick={common.error?.redirectOnClick}
            should_clear_error_on_click={common.error?.should_clear_error_on_click}
            setError={common.setError}
            redirect_to={common.error?.redirect_to}
            should_redirect={common.error?.should_redirect}
        />
    );
});

const AppRoot = () => {
    const store = useStore();
    const api_base_initialized = useRef(false);
    const [is_api_initialized, setIsApiInitialized] = useState(false);

    // Landing-page gate:
    //   - Authenticated users skip the landing page entirely.
    //   - Guest users who already clicked "Continue to Preview" this session skip it.
    //   - Everyone else sees the landing page first.
    const isAuthenticated = AuthSessionManager.isAuthenticated();
    const hasChosenPreview = !!sessionStorage.getItem(PREVIEW_MODE_KEY);
    const [show_landing, setShowLanding] = useState(!isAuthenticated && !hasChosenPreview);

    // Initialize WebSocket API directly — no Firebase/TMB gate.
    // TMB check has been removed; WebSocket startup depends only on the
    // canonical AuthSessionManager state (token in storage → authorize).
    useEffect(() => {
        const timeoutId = setTimeout(() => {
            if (!is_api_initialized) {
                setIsApiInitialized(true);
            }
        }, 5000);

        const initializeApi = async () => {
            if (!api_base_initialized.current) {
                try {
                    await api_base.init();
                    api_base_initialized.current = true;
                } catch (error) {
                    console.error('API initialization failed:', error);
                    api_base_initialized.current = false;
                } finally {
                    setIsApiInitialized(true);
                    clearTimeout(timeoutId);
                }
            }
        };

        initializeApi();
        return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Show landing page while API is still booting AND user is unauthenticated —
    // we don't want the splash screen competing with the landing page.
    if (show_landing) {
        return <LandingPage onContinueToPreview={() => setShowLanding(false)} />;
    }

    if (!store || !is_api_initialized) return <AppRootLoader />;

    return (
        <Suspense fallback={<AppRootLoader />}>
            <ErrorBoundary root_store={store}>
                <ErrorComponentWrapper />
                <AppContent />
            </ErrorBoundary>
        </Suspense>
    );
};

export default AppRoot;
