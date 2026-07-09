/**
 * AuthManager — global token lifecycle manager.
 *
 * Responsibilities:
 *   - Proactively refresh the OTP WebSocket token before it expires
 *   - Reconnect WebSocketManager with the fresh token
 *   - Emit auth-specific events on EventBus
 *
 * IMPORTANT: AuthManager never triggers chart reinitialization.
 * ChartDataLayer listens to ws:connected/ws:disconnected and
 * handles data-source transitions transparently.
 */

import { AuthSessionManager } from './AuthSessionManager';
import { EventBus } from './EventBus';
import { WebSocketManager } from './WebSocketManager';

// OTP URLs expire in ~30 min; refresh 5 min before expiry.
const REFRESH_INTERVAL_MS = 25 * 60 * 1_000;

class AuthManagerClass {
    private _refreshTimer: ReturnType<typeof setInterval> | null = null;
    private _isRefreshing = false;

    init(): void {
        // Start refresh cycle if credentials already present in session
        if (AuthSessionManager.isAuthenticated()) {
            this._startRefreshCycle();
        }

        // Start cycle when user logs in
        EventBus.on('auth:success', () => {
            console.log('[AuthManager] auth:success — starting token refresh cycle');
            this._startRefreshCycle();
        });

        // Stop cycle when user logs out
        EventBus.on('auth:logout', () => {
            console.log('[AuthManager] auth:logout — stopping token refresh cycle');
            this._stopRefreshCycle();
        });

        // On WS disconnect: clear the OTP cache so the next reconnect
        // uses a fresh OTP URL. WebSocketManager schedules reconnect
        // automatically; we just ensure it gets fresh credentials.
        EventBus.on('ws:disconnected', () => {
            if (AuthSessionManager.isAuthenticated()) {
                AuthSessionManager.invalidateOtpCache();
                console.log('[AuthManager] OTP cache invalidated on disconnect');
            }
        });
    }

    /**
     * Force an immediate token refresh (proactive reconnect with fresh OTP).
     * ChartDataLayer handles the seamless data-source swap on ws:connected.
     */
    async refreshNow(): Promise<void> {
        if (this._isRefreshing) {
            console.log('[AuthManager] Refresh already in progress — skipping');
            return;
        }
        this._isRefreshing = true;
        try {
            console.log('[AuthManager] Proactive token refresh — reconnecting WS with fresh OTP');
            AuthSessionManager.invalidateOtpCache();
            // Gracefully reconnect — WebSocketManager emits ws:disconnected → ws:connected
            // which ChartDataLayer handles transparently (no chart remount).
            WebSocketManager.disconnect();
            await WebSocketManager.connect();
            console.log('[AuthManager] Token refresh complete');
        } catch (e) {
            console.error('[AuthManager] Token refresh failed:', e);
        } finally {
            this._isRefreshing = false;
        }
    }

    private _startRefreshCycle(): void {
        this._stopRefreshCycle();
        this._refreshTimer = setInterval(() => {
            if (AuthSessionManager.isAuthenticated()) {
                this.refreshNow();
            } else {
                this._stopRefreshCycle();
            }
        }, REFRESH_INTERVAL_MS);
        console.log('[AuthManager] Refresh cycle started — interval:', REFRESH_INTERVAL_MS / 60_000, 'min');
    }

    private _stopRefreshCycle(): void {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
    }
}

export const AuthManager = new AuthManagerClass();
