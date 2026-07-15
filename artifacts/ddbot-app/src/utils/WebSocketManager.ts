// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for this module
import DerivAPIBasic from '@deriv/deriv-api/dist/DerivAPIBasic';
import APIMiddleware from '../external/bot-skeleton/services/api/api-middleware';
import { AccountModeController } from './AccountModeController';
import { AuthSessionManager } from './AuthSessionManager';
import { EventBus, type EventMap } from './EventBus';
import { PUBLIC_WS_URL } from './derivWs';

const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_MS = 2_000;

function maskToken(t: string | null | undefined): string {
    if (!t) return '(none)';
    if (t.length <= 12) return t.slice(0, 4) + '…';
    return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

class WebSocketManagerClass {
    private _api: InstanceType<typeof DerivAPIBasic> | null = null;
    private _socket: WebSocket | null = null;
    private _connected = false;
    private _connecting: Promise<void> | null = null;
    private _reconnectAttempts = 0;
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _stopReconnect = false;
    private _pendingOtpToken: string | null = null;

    /** The OTP token extracted from the current authenticated WS URL. */
    getPendingOtpToken(): string | null {
        return this._pendingOtpToken;
    }

    wasLastConnectionOtp(): boolean {
        return this._pendingOtpToken !== null;
    }

    /**
     * Returns the shared DerivAPIBasic instance.
     * Throws if WebSocketManager is not yet connected.
     */
    getApi(): InstanceType<typeof DerivAPIBasic> {
        if (!this._api) throw new Error('WebSocketManager: not connected — call connect() first');
        return this._api;
    }

    getSocket(): WebSocket | null {
        return this._socket;
    }

    isConnected(): boolean {
        return this._connected && this._socket?.readyState === WebSocket.OPEN;
    }

    /**
     * Establishes ONE authenticated WebSocket connection.
     * Concurrent callers receive the same Promise (no double-connect).
     * Returns immediately if already connected.
     */
    connect(): Promise<void> {
        if (this.isConnected()) {
            console.log('[AUTH 11][WSManager.connect] Already connected — returning immediately');
            return Promise.resolve();
        }
        if (this._connecting) {
            console.log('[AUTH 11][WSManager.connect] Connection already in-flight — deduplicating');
            return this._connecting;
        }

        this._stopReconnect = false;
        this._connecting = this._doConnect().finally(() => {
            this._connecting = null;
        });
        return this._connecting;
    }

    disconnect(): void {
        this._stopReconnect = true;
        this._clearReconnectTimer();
        this._teardown();
    }

    /**
     * Send a raw payload through the shared socket.
     * Use only when you need raw WS access (e.g., trading engine proposals).
     * For high-level call/response prefer `getApi()`.
     */
    send(payload: object): void {
        if (this._socket?.readyState === WebSocket.OPEN) {
            this._socket.send(JSON.stringify(payload));
        } else {
            console.warn('[WSManager] send() called but socket is not open');
        }
    }

    private async _doConnect(): Promise<void> {
        let wsUrl = PUBLIC_WS_URL;
        this._pendingOtpToken = null;

        // OTP fetch is gated on AccountModeController, not on stored tokens.
        // This ensures the public WebSocket connects immediately on startup,
        // and the authenticated OTP URL is only requested after the user has
        // explicitly initiated Account Mode via AccountModeController.enter().
        const accountModeActive = AccountModeController.isAccountModeActive();
        const { accountId: _logAccountId, accessToken: _logToken } = AuthSessionManager.getAuthInfo();
        console.log('[AUTH 11][WSManager._doConnect] Starting connection',
            '| accountModeActive:', accountModeActive,
            '| accountId (ASM):', _logAccountId ?? '(none)',
            '| hasAuthToken (ASM):', !!_logToken,
        );

        if (accountModeActive) {
            try {
                console.log('[AUTH 12][WSManager._doConnect] → Requesting OTP WS URL…');
                const { url, token } = await AuthSessionManager.getOtpWsUrl();
                wsUrl = url;
                this._pendingOtpToken = token;
                console.log('[AUTH 12][WSManager._doConnect] ← OTP URL obtained',
                    '| hasOtpToken:', !!token,
                    '| maskedOtp:', maskToken(token),
                );
            } catch (e) {
                console.warn('[AUTH 12][WSManager._doConnect] OTP fetch FAILED — falling back to PUBLIC WS',
                    '| reason:', (e as Error).message,
                    '| PUBLIC_WS_URL:', PUBLIC_WS_URL,
                );
            }
        } else {
            console.log('[AUTH 11][WSManager._doConnect] Account Mode not active — connecting with PUBLIC WS URL (no OTP)');
        }

        console.log('[AUTH 12b][WSManager._doConnect] Opening WebSocket',
            '| isOtpUrl:', wsUrl !== PUBLIC_WS_URL,
            '| urlHost:', (() => { try { return new URL(wsUrl).host; } catch { return wsUrl.slice(0, 40); } })(),
        );

        return new Promise<void>((resolve, reject) => {
            this._teardown();

            let socket: WebSocket;
            try {
                socket = new WebSocket(wsUrl);
            } catch (e) {
                console.error('[AUTH 12b][WSManager._doConnect] new WebSocket() threw:', e);
                reject(e);
                return;
            }

            this._socket = socket;

            const connectTimeout = setTimeout(() => {
                console.error('[AUTH 12b][WSManager._doConnect] Connection TIMED OUT after 15s');
                reject(new Error('WebSocketManager: connection timed out'));
                socket.close();
            }, 15_000);

            // Intercept socket.send() to log the raw JSON bytes going over the wire.
            // This is the ground truth — it confirms what schema the API actually receives,
            // regardless of any middleware or library-level transformations.
            const _originalSend = socket.send.bind(socket);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (socket as any).send = (data: string | ArrayBuffer | Blob | ArrayBufferView) => {
                if (typeof data === 'string') {
                    try {
                        const parsed = JSON.parse(data);
                        // Skip authorize — contains tokens; skip ping-like messages
                        if (!parsed.authorize && !parsed.ping) {
                            console.log('[WS-RAW-SEND]', data.length > 600 ? data.slice(0, 600) + '…' : data);
                        }
                    } catch {}
                }
                return _originalSend(data);
            };

            socket.addEventListener('open', () => {
                clearTimeout(connectTimeout);
                this._connected = true;
                this._reconnectAttempts = 0;
                console.log('[AUTH 13][WSManager] ✓ WebSocket OPEN',
                    '| wasOtpUrl:', wsUrl !== PUBLIC_WS_URL,
                    '| pendingOtpToken:', maskToken(this._pendingOtpToken),
                );
                EventBus.emit('ws:connected', undefined);
                resolve();
            });

            socket.addEventListener('message', (evt: MessageEvent) => {
                try {
                    const msg = JSON.parse(evt.data as string);
                    this._routeMessage(msg);
                } catch {}
            });

            socket.addEventListener('close', (evt: CloseEvent) => {
                clearTimeout(connectTimeout);
                const wasConnected = this._connected;
                this._connected = false;
                AuthSessionManager.invalidateOtpCache();
                if (wasConnected) {
                    console.warn('[WSManager] Disconnected',
                        '| code:', evt.code,
                        '| reason:', evt.reason || '(none)',
                        '— scheduling reconnect',
                    );
                    EventBus.emit('ws:disconnected', undefined);
                    this._scheduleReconnect();
                } else {
                    console.warn('[WSManager] Socket closed before open event fired',
                        '| code:', evt.code,
                        '| reason:', evt.reason || '(none)',
                    );
                }
            });

            socket.addEventListener('error', (evt) => {
                clearTimeout(connectTimeout);
                console.error('[WSManager] WebSocket error event fired', evt);
            });

            this._api = new DerivAPIBasic({
                connection: socket,
                middleware: new APIMiddleware({}),
            });
        });
    }

    private _routeMessage(msg: Record<string, unknown>): void {
        if (!msg?.msg_type) return;

        switch (msg.msg_type) {
            case 'tick':
                EventBus.emit('tick', msg.tick as EventMap['tick']);
                break;
            case 'balance':
                EventBus.emit('balance', msg.balance as EventMap['balance']);
                break;
            case 'transaction':
                EventBus.emit('transaction', msg.transaction);
                break;
            case 'proposal':
                EventBus.emit('proposal', msg as EventMap['proposal']);
                break;
            case 'buy':
                EventBus.emit('buy', msg as EventMap['buy']);
                break;
            case 'proposal_open_contract':
                EventBus.emit('proposal_open_contract', msg as EventMap['proposal_open_contract']);
                break;
            case 'authorize':
                if (msg.error) {
                    console.warn('[AUTH 15][WSManager] authorize WS message — ERROR:',
                        (msg.error as Record<string, unknown>)?.code,
                        (msg.error as Record<string, unknown>)?.message,
                    );
                    EventBus.emit('auth:failed', msg.error as EventMap['auth:failed']);
                } else {
                    console.log('[AUTH 15][WSManager] authorize WS message — SUCCESS',
                        '| loginid:', (msg.authorize as Record<string, unknown>)?.loginid,
                    );
                    EventBus.emit('auth:success', msg.authorize as EventMap['auth:success']);
                }
                break;
            default:
                break;
        }
    }

    private _teardown(): void {
        if (this._socket) {
            const s = this._socket;
            this._socket = null;
            this._api = null;
            this._connected = false;
            s.onopen = null;
            s.onclose = null;
            s.onmessage = null;
            s.onerror = null;
            try {
                if (s.readyState < WebSocket.CLOSING) s.close();
            } catch {}
        }
    }

    private _scheduleReconnect(): void {
        if (this._stopReconnect) return;
        if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.error('[WSManager] Max reconnect attempts reached — giving up');
            return;
        }

        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts), 60_000);
        this._reconnectAttempts++;
        console.log(`[WSManager] Reconnect attempt ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s`);

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect().catch(e => console.error('[WSManager] Reconnect failed:', e));
        }, delay);
    }

    private _clearReconnectTimer(): void {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }
}

export const WebSocketManager = new WebSocketManagerClass();
