import React, { createContext, useContext, useEffect, useState } from 'react';
import { AuthSessionManager } from './AuthSessionManager';
import { EventBus } from './EventBus';
import { WebSocketManager } from './WebSocketManager';

export type AuthReadyState = {
    isWsConnected: boolean;
    isAuthReady: boolean;
    isAuthorized: boolean;
};

const AuthReadyContext = createContext<AuthReadyState>({
    isWsConnected: false,
    // Default true: preview mode is always ready — chart never blocked by auth.
    isAuthReady: true,
    isAuthorized: false,
});

export const AuthReadyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [state, setState] = useState<AuthReadyState>(() => ({
        isWsConnected: WebSocketManager.isConnected(),
        // Preview mode is always ready — chart renders immediately without auth.
        // Auth state only upgrades the data source (mock → live), never blocks the chart.
        isAuthReady: true,
        // Initialise from canonical state so first render is accurate.
        isAuthorized: AuthSessionManager.getCanonicalAuthState().isAuthorized,
    }));

    useEffect(() => {
        console.log('[AuthReady] Provider mounted — isConnected:', WebSocketManager.isConnected());

        // isWsConnected + isAuthReady (guest detection) — EventBus for WS lifecycle.
        const unsubConnected = EventBus.on('ws:connected', () => {
            console.log('[AuthReady] ws:connected');
            setState(prev => {
                const canonical = AuthSessionManager.getCanonicalAuthState();
                const isGuest = !canonical.isAuthenticated;
                if (isGuest) console.log('[AuthReady] Guest mode — marking authReady immediately');
                return { ...prev, isWsConnected: true, isAuthReady: prev.isAuthReady || isGuest };
            });
        });

        const unsubDisconnected = EventBus.on('ws:disconnected', () => {
            console.log('[AuthReady] ws:disconnected');
            setState(prev => ({ ...prev, isWsConnected: false }));
        });

        // isAuthReady: mark complete when auth attempt finishes (success or failure).
        // These still use EventBus because isAuthReady tracks flow completion, not session state.
        const unsubAuthSuccess = EventBus.on('auth:success', data => {
            console.log('[AuthReady] auth:success — loginid:', (data as any)?.loginid);
            setState(prev => ({ ...prev, isAuthReady: true }));
        });

        const unsubAuthFailed = EventBus.on('auth:failed', data => {
            console.warn('[AuthReady] auth:failed — code:', (data as any)?.code);
            setState(prev => ({ ...prev, isAuthReady: true }));
        });

        // isAuthorized: derived exclusively from canonical state — no direct localStorage reads.
        const unsubAuthChange = AuthSessionManager.onAuthChange(() => {
            const canonical = AuthSessionManager.getCanonicalAuthState();
            setState(prev => ({ ...prev, isAuthorized: canonical.isAuthorized }));
        });

        // Sync immediately if WS is already connected when this effect runs.
        if (WebSocketManager.isConnected()) {
            const canonical = AuthSessionManager.getCanonicalAuthState();
            setState(prev => ({
                ...prev,
                isWsConnected: true,
                isAuthReady: prev.isAuthReady || !canonical.isAuthenticated,
            }));
        }

        const fallback = setTimeout(() => {
            setState(prev => {
                if (!prev.isAuthReady) {
                    console.warn('[AuthReady] 10s fallback — forcing isAuthReady=true');
                }
                return { ...prev, isAuthReady: true };
            });
        }, 10_000);

        return () => {
            unsubConnected();
            unsubDisconnected();
            unsubAuthSuccess();
            unsubAuthFailed();
            unsubAuthChange();
            clearTimeout(fallback);
        };
    }, []);

    return <AuthReadyContext.Provider value={state}>{children}</AuthReadyContext.Provider>;
};

export const useAuthReady = () => useContext(AuthReadyContext);
