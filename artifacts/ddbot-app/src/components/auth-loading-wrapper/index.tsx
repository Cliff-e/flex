import React from 'react';
import { useOauth2 } from '@/hooks/auth/useOauth2';
import useTMB from '@/hooks/useTMB';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { Loader } from '@deriv-com/ui';

type AuthLoadingWrapperProps = {
    children: React.ReactNode;
};

const AuthLoadingWrapper = ({ children }: AuthLoadingWrapperProps) => {
    const { isSingleLoggingIn } = useOauth2();
    const { isTmbEnabled } = useTMB();

    const is_tmb_enabled = isTmbEnabled() || window.is_tmb_enabled === true;

    // Only block the app with an SSO loading screen when credentials are present.
    // Without credentials the user is in guest / preview mode and may have a
    // stale `logged_state = "true"` cookie from a previous authenticated session.
    // That stale cookie causes isSingleLoggingIn=true which would hide the entire
    // app behind a full-screen loader.  Guests must always see the app directly.
    // RULE: use canonical auth check — no direct localStorage reads.
    const hasToken = AuthSessionManager.isAuthenticated();

    if (isSingleLoggingIn && !is_tmb_enabled && hasToken) {
        return <Loader isFullScreen />;
    }

    return <>{children}</>;
};

export default AuthLoadingWrapper;
