/**
 * AuthLoadingWrapper
 *
 * Legacy OIDC SSO detection (isSingleLoggingIn + useTMB) has been removed.
 * The header's `isLoggedIn && !activeLoginid` branch handles the "token present
 * but WS not yet authorized" loading state correctly.
 *
 * This wrapper is kept as a pass-through for structural compatibility.
 */
import React from 'react';

type AuthLoadingWrapperProps = {
    children: React.ReactNode;
};

const AuthLoadingWrapper = ({ children }: AuthLoadingWrapperProps) => {
    return <>{children}</>;
};

export default AuthLoadingWrapper;
