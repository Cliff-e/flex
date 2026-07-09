/**
 * AuthWrapper — application root.
 *
 * The legacy Deriv implicit-flow (URL params with token1=, loginid1=, …) has
 * been removed. Authentication is handled exclusively by the DigitalOcean
 * backend + CallbackPage (/auth/callback). This component is a thin pass-through
 * that exists to preserve the import contract in main.tsx.
 */
import React from 'react';
import App from './App';

export const AuthWrapper = () => {
    return <App />;
};
