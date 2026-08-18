/**
 * PublicMarketSocket — a dedicated, auth-free WebSocket for market data.
 *
 * KEY RULES:
 *  • Connects to PUBLIC_WS_URL only — no OTP, no auth token, ever.
 *  • Reconnects infinitely — no attempt cap (public data must never give up).
 *  • Never disconnects due to auth state changes (login / logout are invisible).
 *  • Emits EventBus events: 'public:connected', 'public:disconnected', 'public:tick'.
 *  • Completely separate from WebSocketManager (the private/trading socket).
 */
import { EventBus, type EventMap } from './EventBus';
import { PUBLIC_WS_URL } from './derivWs';

const RECONNECT_BASE_MS = 2_000;
const MAX_BACKOFF_ATTEMPTS = 6; // caps delay at ~64s, then stays there forever

class PublicMarketSocketClass {
    private _socket: WebSocket | null = null;
    private _connected = false;
    private _connecting: Promise<void> | null = null;
    private _reconnectAttempts = 0;
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _stopped = false;

    isConnected(): boolean {
        return this._connected && this._socket?.readyState === WebSocket.OPEN;
    }

    getSocket(): WebSocket | null {
        return this._socket;
    }

    /**
     * Establishes a public WebSocket connection.
     * Concurrent callers receive the same Promise.
     * Returns immediately if already connected.
     */
    connect(): Promise<void> {
        if (this.isConnected()) return Promise.resolve();
        if (this._connecting) return this._connecting;

        this._stopped = false;
        this._connecting = this._doConnect().finally(() => {
            this._connecting = null;
        });
        return this._connecting;
    }

    send(payload: object): void {
        if (this._socket?.readyState === WebSocket.OPEN) {
            this._socket.send(JSON.stringify(payload));
        } else {
            console.warn('[PublicMarketSocket] send() called but socket is not open');
        }
    }

    private _doConnect(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this._teardown();

            let socket: WebSocket;
            try {
                socket = new WebSocket(PUBLIC_WS_URL);
            } catch (e) {
                console.error('[PublicMarketSocket] new WebSocket() threw:', e);
                reject(e);
                return;
            }

            this._socket = socket;

            const connectTimeout = setTimeout(() => {
                console.error('[PublicMarketSocket] Connection timed out after 15s');
                reject(new Error('PublicMarketSocket: connection timed out'));
                socket.close();
            }, 15_000);

            socket.addEventListener('open', () => {
                clearTimeout(connectTimeout);
                this._connected = true;
                this._reconnectAttempts = 0;
                console.log('[PublicMarketSocket] ✓ Connected (public WS, no auth)');
                EventBus.emit('public:connected', undefined);
                resolve();
            });

            socket.addEventListener('message', (evt: MessageEvent) => {
                try {
                    const msg = JSON.parse(evt.data as string) as Record<string, unknown>;
                    if (msg?.msg_type === 'tick') {
                        EventBus.emit('public:tick', msg.tick as EventMap['public:tick']);
                    }
                } catch { /* ignore parse errors */ }
            });

            socket.addEventListener('close', (evt: CloseEvent) => {
                clearTimeout(connectTimeout);
                const wasConnected = this._connected;
                this._connected = false;
                if (wasConnected) {
                    console.warn('[PublicMarketSocket] Disconnected',
                        '| code:', evt.code, '| reason:', evt.reason || '(none)',
                        '— will reconnect (no cap)',
                    );
                    EventBus.emit('public:disconnected', undefined);
                }
                if (!this._stopped) this._scheduleReconnect();
            });

            socket.addEventListener('error', () => {
                clearTimeout(connectTimeout);
            });
        });
    }

    private _teardown(): void {
        if (this._socket) {
            const s = this._socket;
            this._socket = null;
            this._connected = false;
            s.onopen = null;
            s.onclose = null;
            s.onmessage = null;
            s.onerror = null;
            try { if (s.readyState < WebSocket.CLOSING) s.close(); } catch { /* ignore */ }
        }
    }

    private _scheduleReconnect(): void {
        if (this._stopped) return;
        // Infinite reconnect — public data must never give up.
        // Backoff is capped so we don't wait more than ~64s between attempts.
        const attempt = Math.min(this._reconnectAttempts, MAX_BACKOFF_ATTEMPTS);
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), 64_000);
        this._reconnectAttempts++;
        console.log(`[PublicMarketSocket] Reconnect #${this._reconnectAttempts} in ${delay / 1000}s`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect().catch(() => { /* next close will re-schedule */ });
        }, delay);
    }
}

export const PublicMarketSocket = new PublicMarketSocketClass();
