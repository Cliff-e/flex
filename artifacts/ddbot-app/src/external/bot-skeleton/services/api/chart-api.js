import { WebSocketManager } from '@/utils/WebSocketManager';
import { EventBus } from '@/utils/EventBus';

/**
 * ChartAPI — singleton that exposes the shared DerivAPIBasic instance
 * to the SmartChart component. No longer creates its own WebSocket;
 * it reuses the ONE connection managed by WebSocketManager.
 */
class ChartAPI {
    api = null;
    _ready = false;
    _readyCallbacks = [];
    _wsUnsub = null;

    constructor() {
        // Listen for WebSocketManager connection events so _ready stays in sync
        this._wsUnsub = EventBus.on('ws:connected', () => {
            this._ready = true;
            this.api = WebSocketManager.getApi();
            const cbs = this._readyCallbacks.slice();
            this._readyCallbacks = [];
            cbs.forEach(cb => cb());
        });

        EventBus.on('ws:disconnected', () => {
            this._ready = false;
        });
    }

    waitReady = () => {
        if (this._ready && WebSocketManager.isConnected()) {
            return Promise.resolve();
        }
        return new Promise(resolve => {
            this._readyCallbacks.push(resolve);
        });
    };

    init = () => {
        if (WebSocketManager.isConnected()) {
            this._ready = true;
            this.api = WebSocketManager.getApi();
        } else {
            this._ready = false;
            // WebSocketManager will reconnect automatically; listen via EventBus
            WebSocketManager.connect().catch(err =>
                console.error('[ChartAPI] connect error:', err)
            );
        }
    };
}

const chart_api = new ChartAPI();
export default chart_api;
