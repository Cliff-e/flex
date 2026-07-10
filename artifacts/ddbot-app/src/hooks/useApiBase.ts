import { useEffect, useState } from 'react';
import {
    account_list$,
    authData$,
    CONNECTION_STATUS,
    connectionStatus$,
    isAuthorizing$,
} from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { TAuthData } from '@/types/api-types';

export const useApiBase = () => {
    const [connectionStatus, setConnectionStatus] = useState<CONNECTION_STATUS>(CONNECTION_STATUS.UNKNOWN);

    // Auth decisions derived exclusively from AuthSessionManager canonical state.
    // Initialise synchronously so the first render already reflects the real state.
    const [isAuthorized, setIsAuthorized] = useState<boolean>(
        () => AuthSessionManager.getCanonicalAuthState().isAuthorized
    );
    const [isLoggedIn, setIsLoggedIn] = useState<boolean>(
        () => AuthSessionManager.getCanonicalAuthState().isAuthenticated
    );

    // Operational state — still driven by RxJS observables (not auth decisions).
    const [isAuthorizing, setIsAuthorizing] = useState<boolean>(false);
    const [accountList, setAccountList] = useState<TAuthData['account_list']>([]);
    const [authData, setAuthData] = useState<TAuthData | null>(null);
    const [activeLoginid, setActiveLoginid] = useState<string>('');

    useEffect(() => {
        // Connection + operational state via RxJS (unchanged).
        const connectionStatusSubscription = connectionStatus$.subscribe(status => {
            setConnectionStatus(status as CONNECTION_STATUS);
        });
        const isAuthorizingSubscription = isAuthorizing$.subscribe(authorizing => {
            setIsAuthorizing(authorizing);
        });
        const accountListSubscription = account_list$.subscribe(list => {
            setAccountList(list);
        });
        const authDataSubscription = authData$.subscribe(data => {
            setAuthData(data);
            setActiveLoginid(data?.loginid ?? '');
        });

        // Auth decisions via canonical state — single source of truth.
        const unsubAuthChange = AuthSessionManager.onAuthChange(() => {
            const canonical = AuthSessionManager.getCanonicalAuthState();
            setIsAuthorized(canonical.isAuthorized);
            setIsLoggedIn(canonical.isAuthenticated);
        });

        return () => {
            connectionStatusSubscription.unsubscribe();
            isAuthorizingSubscription.unsubscribe();
            accountListSubscription.unsubscribe();
            authDataSubscription.unsubscribe();
            unsubAuthChange();
        };
    }, []);

    return {
        connectionStatus,
        isAuthorized,
        isLoggedIn,
        isAuthorizing,
        accountList,
        authData,
        activeLoginid,
    };
};
