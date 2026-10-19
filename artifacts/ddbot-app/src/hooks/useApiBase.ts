import { useEffect, useRef, useState } from 'react';
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
    // isLoggedIn is true whenever an access token exists in storage, even when
    // the loginid is not yet known (token-only state after OAuth callback when
    // the accounts fetch failed). This prevents the Login/Sign Up flash while
    // WS authorize() is running. isAuthenticated() requires BOTH token + loginid
    // and would incorrectly return false in the token-only state.
    const [isLoggedIn, setIsLoggedIn] = useState<boolean>(
        () => !!AuthSessionManager.getAuthInfo().accessToken
    );

    // Operational state — still driven by RxJS observables (not auth decisions).
    const [isAuthorizing, setIsAuthorizing] = useState<boolean>(false);

    // Account DISPLAY state. It is bootstrapped from the canonical accounts the
    // OAuth backend already fetched and AuthSessionManager persisted. The WS
    // authorize response remains authoritative: once it produces a non-empty
    // list / loginid, these values take over and stored data is no longer used.
    //
    // This does NOT mark the session authorized — trading is still gated by
    // AuthSessionManager.isAuthorized(). It only prevents the header from
    // showing a permanent loading skeleton when authorize() is slow or fails.
    const [accountList, setAccountList] = useState<TAuthData['account_list']>(() =>
        AuthSessionManager.getStoredAccounts()
    );
    const [authData, setAuthData] = useState<TAuthData | null>(null);
    const [activeLoginid, setActiveLoginid] = useState<string>(() => {
        const { accountId } = AuthSessionManager.getAuthInfo();
        if (!accountId) return '';
        const stored = AuthSessionManager.getStoredAccounts();
        return stored.some(account => account.loginid === accountId) ? accountId : '';
    });
    const wsAccountStateAuthoritative = useRef(false);

    useEffect(() => {
        // Connection + operational state via RxJS (unchanged).
        const connectionStatusSubscription = connectionStatus$.subscribe(status => {
            setConnectionStatus(status as CONNECTION_STATUS);
        });
        const isAuthorizingSubscription = isAuthorizing$.subscribe(authorizing => {
            setIsAuthorizing(authorizing);
        });
        const accountListSubscription = account_list$.subscribe(list => {
            if (list?.length) {
                wsAccountStateAuthoritative.current = true;
                setAccountList(list);
            } else if (wsAccountStateAuthoritative.current) {
                // An authoritative empty list means the session was cleared.
                setAccountList([]);
            } else {
                setAccountList(AuthSessionManager.getStoredAccounts());
            }
        });
        const authDataSubscription = authData$.subscribe(data => {
            setAuthData(data);
            if (data?.loginid) {
                wsAccountStateAuthoritative.current = true;
                setActiveLoginid(data.loginid);
            } else if (wsAccountStateAuthoritative.current) {
                setActiveLoginid('');
            } else {
                const { accountId } = AuthSessionManager.getAuthInfo();
                const stored = AuthSessionManager.getStoredAccounts();
                setActiveLoginid(
                    accountId && stored.some(account => account.loginid === accountId) ? accountId : ''
                );
            }
        });

        // Auth decisions via canonical state — single source of truth.
        const unsubAuthChange = AuthSessionManager.onAuthChange(() => {
            const canonical = AuthSessionManager.getCanonicalAuthState();
            setIsAuthorized(canonical.isAuthorized);
            // isLoggedIn: true whenever a token exists — see comment on initial state above.
            setIsLoggedIn(!!AuthSessionManager.getAuthInfo().accessToken);

            // Refresh the display snapshot while the WS has not produced its own
            // account data yet (login completion, account list repair, logout).
            if (!wsAccountStateAuthoritative.current) {
                const stored = AuthSessionManager.getStoredAccounts();
                setAccountList(stored);
                const { accountId } = AuthSessionManager.getAuthInfo();
                setActiveLoginid(previous =>
                    stored.some(account => account.loginid === previous)
                        ? previous
                        : accountId && stored.some(account => account.loginid === accountId)
                          ? accountId
                          : ''
                );
            }
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
