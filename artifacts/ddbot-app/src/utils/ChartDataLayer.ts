/**
 * ChartDataLayer — decouples SmartChart rendering from auth/WebSocket state.
 *
 * Data modes (automatic, transparent to SmartChart):
 *   preview  – synthetic price-walk ticks generated locally; available instantly
 *   live     – real tick stream from PublicMarketSocket; activated when public WS connects
 *
 * Transitions:
 *   Public WS connects    → seamlessly swap mock timer for live stream (no chart remount)
 *   Public WS disconnects → seamlessly fall back to price-walk from last cached price
 *   Auth changes          → completely ignored by this layer
 *
 * ARCHITECTURE: This layer uses PublicMarketSocket (auth-free) exclusively.
 * It NEVER touches WebSocketManager (the private trading socket).
 * Charts and indicators must work regardless of login state.
 */

import { EventBus } from './EventBus';
import { PublicMarketSocket } from './PublicMarketSocket';

// ── Realistic base prices per symbol ────────────────────────────────────────
const MOCK_BASE_PRICES: Record<string, number> = {
    // Continuous Indices
    R_10: 6_500.00, R_25: 8_200.00, R_50: 4_500.00, R_75: 3_800.00, R_100: 10_000.00,
    stpRNG: 100.00,
    // 1-Second Indices
    '1HZ10V': 2_500.00, '1HZ15V': 2_750.00, '1HZ25V': 3_100.00,
    '1HZ30V': 3_400.00, '1HZ50V': 4_800.00, '1HZ75V': 5_200.00,
    '1HZ90V': 5_700.00, '1HZ100V': 6_000.00,
    // Daily Reset
    BOOM300N: 400_000, BOOM500: 600_000, BOOM1000: 900_000,
    CRASH300N: 500_000, CRASH500: 700_000, CRASH1000: 850_000,
    // Jump
    JD10: 150.00, JD25: 200.00, JD50: 300.00,
    JD75: 400.00, JD100: 500.00, JD150: 750.00, JD200: 1_000.00,
    // Range Break
    RNGBEAR200: 5_000.00, RNGBULL200: 5_500.00,
    // Forex Major
    frxEURUSD: 1.08, frxGBPUSD: 1.27, frxUSDJPY: 149.50,
    frxAUDUSD: 0.65, frxUSDCAD: 1.36, frxUSDCHF: 0.90, frxNZDUSD: 0.60,
    // Forex Minor
    frxEURGBP: 0.85, frxEURJPY: 161.00, frxGBPJPY: 189.00,
    frxEURAUD: 1.65, frxEURCAD: 1.47, frxEURCHF: 0.97,
    frxGBPAUD: 1.94, frxGBPCAD: 1.73, frxGBPCHF: 1.14, frxGBPNZD: 2.11,
    frxAUDCAD: 0.89, frxAUDCHF: 0.59, frxAUDNZD: 1.08, frxAUDJPY: 97.00,
    frxNZDJPY: 90.00, frxNZDCAD: 0.82, frxNZDCHF: 0.54,
    frxCADJPY: 110.00, frxCHFJPY: 166.00,
    // Metals
    frxXAUUSD: 2_350.00, frxXAGUSD: 30.00, frxXPDUSD: 1_050.00, frxXPTUSD: 980.00,
    // Crypto
    cryBTCUSD: 68_000, cryETHUSD: 3_500, cryLTCUSD: 80,
    cryXRPUSD: 0.55, cryDOGEUSD: 0.15, cryADAUSD: 0.45,
    crySOLUSD: 170, cryDOTUSD: 7.5, cryLINKUSD: 14,
    cryBNBUSD: 580, cryEOSUSD: 0.8, cryTRXUSD: 0.12,
    // Stock Indices
    FRXUS500: 5_200, FRXUS30: 39_000,
    FRXUK100: 8_100, FRXDE30: 18_200, FRXFRA40: 8_000, FRXSPAIN35: 11_000,
    FRXHK50: 17_500, FRXJPN225: 38_000, FRXAUS200: 7_800,
};

// ── Tick-to-tick volatility step per symbol ──────────────────────────────────
const MOCK_VOLATILITY: Record<string, number> = {
    // Continuous Indices
    R_10: 2.5, R_25: 8.0, R_50: 18.0, R_75: 30.0, R_100: 50.0, stpRNG: 0.1,
    // 1-Second Indices
    '1HZ10V': 0.5, '1HZ15V': 0.7, '1HZ25V': 1.2,
    '1HZ30V': 1.5, '1HZ50V': 2.5, '1HZ75V': 3.8,
    '1HZ90V': 4.5, '1HZ100V': 6.0,
    // Daily Reset
    BOOM300N: 400.0, BOOM500: 600.0, BOOM1000: 900.0,
    CRASH300N: 500.0, CRASH500: 700.0, CRASH1000: 850.0,
    // Jump
    JD10: 0.5, JD25: 0.8, JD50: 1.5, JD75: 2.0, JD100: 2.5, JD150: 3.5, JD200: 5.0,
    // Range Break
    RNGBEAR200: 15.0, RNGBULL200: 15.0,
    // Forex Major (pip-level volatility)
    frxEURUSD: 0.0003, frxGBPUSD: 0.0004, frxUSDJPY: 0.05,
    frxAUDUSD: 0.0003, frxUSDCAD: 0.0003, frxUSDCHF: 0.0003, frxNZDUSD: 0.0003,
    // Forex Minor
    frxEURGBP: 0.0002, frxEURJPY: 0.06, frxGBPJPY: 0.08,
    frxEURAUD: 0.0005, frxEURCAD: 0.0004, frxEURCHF: 0.0003,
    frxGBPAUD: 0.0006, frxGBPCAD: 0.0005, frxGBPCHF: 0.0004, frxGBPNZD: 0.0006,
    frxAUDCAD: 0.0003, frxAUDCHF: 0.0003, frxAUDNZD: 0.0003, frxAUDJPY: 0.04,
    frxNZDJPY: 0.04, frxNZDCAD: 0.0003, frxNZDCHF: 0.0003,
    frxCADJPY: 0.04, frxCHFJPY: 0.05,
    // Metals
    frxXAUUSD: 1.5, frxXAGUSD: 0.05, frxXPDUSD: 3.0, frxXPTUSD: 2.5,
    // Crypto
    cryBTCUSD: 150, cryETHUSD: 12, cryLTCUSD: 0.5,
    cryXRPUSD: 0.003, cryDOGEUSD: 0.001, cryADAUSD: 0.003,
    crySOLUSD: 1.5, cryDOTUSD: 0.05, cryLINKUSD: 0.08,
    cryBNBUSD: 3.0, cryEOSUSD: 0.005, cryTRXUSD: 0.001,
    // Stock Indices
    FRXUS500: 8.0, FRXUS30: 50.0,
    FRXUK100: 15.0, FRXDE30: 30.0, FRXFRA40: 15.0, FRXSPAIN35: 20.0,
    FRXHK50: 50.0, FRXJPN225: 80.0, FRXAUS200: 15.0,
};

export type DataMode = 'preview' | 'live';

interface ActiveSub {
    gen: number;
    req: Record<string, unknown>;
    callback: (data: unknown) => void;
    symbol: string;
    mockTimer: ReturnType<typeof setInterval> | null;
    liveCleanup: (() => void) | null;
    mockPrice: number;
    aborted: boolean;
}

class ChartDataLayerClass {
    private _mode: DataMode = 'preview';
    private _gen = 0;
    private _active: ActiveSub | null = null;
    // Per-symbol tick cache — used to seed mock price on downgrade
    private _tickCache = new Map<string, { quote: number; epoch: number }>();

    constructor() {
        // Sync initial state from the PUBLIC socket (not the private trading socket)
        if (PublicMarketSocket.isConnected()) this._mode = 'live';

        // Listen to PUBLIC socket events — auth state is irrelevant here
        EventBus.on('public:connected', () => {
            const prev = this._mode;
            this._mode = 'live';
            console.log('[ChartDataLayer] public:connected — mode:', prev, '→ live');
            if (prev === 'preview' && this._active && !this._active.aborted) {
                this._upgradeToLive(this._active);
            }
        });

        EventBus.on('public:disconnected', () => {
            this._mode = 'preview';
            console.log('[ChartDataLayer] public:disconnected — mode: live → preview');
            if (this._active && !this._active.aborted) {
                this._downgradeToPrview(this._active);
            }
        });
    }

    get mode(): DataMode { return this._mode; }

    // ── Public API (mirrors SmartChart prop signatures) ──────────────────────

    /**
     * Drop-in replacement for SmartChart's requestSubscribe prop.
     * Always begins delivering data immediately — mock in preview, live via public WS.
     */
    requestSubscribe(req: Record<string, unknown>, callback: (data: unknown) => void): void {
        const gen = ++this._gen;

        // Cancel the previous subscription before starting the new one
        if (this._active) this._cancelActive(this._active);

        const symbol = this._safeSymbol(req);
        const cached = this._tickCache.get(symbol);
        const mockPrice = cached?.quote ?? MOCK_BASE_PRICES[symbol] ?? 1_000.0;

        const active: ActiveSub = {
            gen,
            req: { ...req, ticks_history: symbol },
            callback,
            symbol,
            mockTimer: null,
            liveCleanup: null,
            mockPrice,
            aborted: false,
        };
        this._active = active;

        if (this._mode === 'live' && PublicMarketSocket.isConnected()) {
            this._startLive(active);
        } else {
            this._startPreview(active);
        }
    }

    /**
     * Forget a specific subscription id.
     */
    requestForget(id: string): void {
        if (!id) return;
        const socket = PublicMarketSocket.getSocket();
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ forget: id }));
        }
    }

    requestForgetStream(id: string): void {
        this.requestForget(id);
    }

    /**
     * Cancel the currently active subscription (call on chart unmount).
     */
    cancelCurrent(): void {
        if (this._active) {
            this._cancelActive(this._active);
            this._active = null;
        }
    }

    // ── Preview mode ─────────────────────────────────────────────────────────

    private _startPreview(active: ActiveSub): void {
        console.log('[ChartDataLayer] ▶ preview mode for', active.symbol);

        // Generate initial synthetic history and send as a history response.
        const history = this._makeHistory(active.symbol, 200);
        const previewSubId = `preview_${active.gen}`;

        active.callback({
            msg_type: 'history',
            req_id: 90000 + (active.gen % 9000),
            subscription: { id: previewSubId },
            history: {
                prices: history.map(t => t.quote),
                times:  history.map(t => t.epoch),
            },
        });

        // Stream mock ticks (1 s for 1Hz symbols, 2 s for others)
        const tickMs = active.symbol.startsWith('1HZ') ? 1_000 : 2_000;
        let price = active.mockPrice;

        active.mockTimer = setInterval(() => {
            if (active.aborted || active.gen !== this._gen) {
                clearInterval(active.mockTimer!);
                active.mockTimer = null;
                return;
            }
            const vol = MOCK_VOLATILITY[active.symbol] ?? 5.0;
            price += (Math.random() - 0.5) * vol * 2;
            price = Math.max(price, vol * 0.1);
            active.mockPrice = price;

            const epoch = Math.floor(Date.now() / 1000);
            this._tickCache.set(active.symbol, { quote: price, epoch });

            active.callback({
                msg_type: 'tick',
                tick: { symbol: active.symbol, quote: price, epoch, pip_size: 4 },
                subscription: { id: previewSubId },
            });
        }, tickMs);
    }

    private _stopPreview(active: ActiveSub): void {
        if (active.mockTimer) {
            clearInterval(active.mockTimer);
            active.mockTimer = null;
        }
    }

    // ── Live mode ─────────────────────────────────────────────────────────────

    private _startLive(active: ActiveSub): void {
        const socket = PublicMarketSocket.getSocket();
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            console.warn('[ChartDataLayer] Live start failed — public socket not open, falling back to preview');
            this._startPreview(active);
            return;
        }

        console.log('[ChartDataLayer] ▶ live mode for', active.symbol, '(via PublicMarketSocket)');

        const reqId = 90000 + (active.gen % 9000);
        const fullReq = { ...active.req, req_id: reqId };
        let subId: string | null = null;
        let listenerRemoved = false;

        const messageHandler = (evt: MessageEvent) => {
            if (active.aborted || active.gen !== this._gen) {
                if (!listenerRemoved) {
                    socket.removeEventListener('message', messageHandler);
                    listenerRemoved = true;
                }
                return;
            }
            let msg: Record<string, unknown>;
            try { msg = JSON.parse(evt.data as string) as Record<string, unknown>; } catch { return; }
            if (!msg) return;

            const isInitial = msg.req_id === reqId;
            const isStream  = subId !== null && (msg.subscription as { id?: string } | undefined)?.id === subId;
            if (!isInitial && !isStream) return;

            if (!subId && (msg.subscription as { id?: string } | undefined)?.id) {
                subId = (msg.subscription as { id: string }).id;
            }

            // If the initial response is an API error (e.g. InvalidSymbol for symbols
            // absent from the new trading API), fall back to preview mode gracefully
            // instead of passing the raw error to SmartChart which leaves the chart blank.
            if (isInitial && msg.error) {
                const errCode = (msg.error as { code?: string }).code;
                console.warn('[ChartDataLayer] Live subscription error for', active.symbol,
                    '→', errCode, '— falling back to preview mode');
                socket.removeEventListener('message', messageHandler);
                listenerRemoved = true;
                this._downgradeToPrview(active);
                return;
            }

            // Cache latest tick price for smooth downgrade
            if (msg.msg_type === 'tick') {
                const tick = msg.tick as { quote: number; epoch: number; symbol: string } | undefined;
                if (tick) {
                    this._tickCache.set(active.symbol, { quote: tick.quote, epoch: tick.epoch });
                    active.mockPrice = tick.quote;
                }
            }

            active.callback(msg);
        };

        socket.addEventListener('message', messageHandler);
        console.log('[ChartDataLayer] Live WS request:', JSON.stringify(fullReq).slice(0, 120));
        socket.send(JSON.stringify(fullReq));

        active.liveCleanup = () => {
            if (!listenerRemoved) {
                socket.removeEventListener('message', messageHandler);
                listenerRemoved = true;
            }
            if (subId) {
                const s = PublicMarketSocket.getSocket();
                if (s?.readyState === WebSocket.OPEN) {
                    s.send(JSON.stringify({ forget: subId }));
                }
            }
        };
    }

    private _stopLive(active: ActiveSub): void {
        if (active.liveCleanup) {
            active.liveCleanup();
            active.liveCleanup = null;
        }
    }

    // ── Mode transitions (no chart remount) ───────────────────────────────────

    private _upgradeToLive(active: ActiveSub): void {
        console.log('[ChartDataLayer] ↑ preview → live for', active.symbol);
        this._stopPreview(active);
        this._startLive(active);
        EventBus.emit('chart:mode_changed', { mode: 'live' });
    }

    private _downgradeToPrview(active: ActiveSub): void {
        console.log('[ChartDataLayer] ↓ live → preview for', active.symbol);
        this._stopLive(active);
        // Seed mock walk from last real price
        const cached = this._tickCache.get(active.symbol);
        if (cached) active.mockPrice = cached.quote;
        this._startPreview(active);
        EventBus.emit('chart:mode_changed', { mode: 'preview' });
    }

    private _cancelActive(active: ActiveSub): void {
        active.aborted = true;
        this._stopPreview(active);
        this._stopLive(active);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private _safeSymbol(req: Record<string, unknown>): string {
        const s = req?.ticks_history;
        return (s && typeof s === 'string' && s.trim() && s !== 'undefined') ? s : 'R_100';
    }

    private _makeHistory(symbol: string, count: number): Array<{ quote: number; epoch: number }> {
        const base = this._tickCache.get(symbol)?.quote ?? MOCK_BASE_PRICES[symbol] ?? 1_000.0;
        const vol  = MOCK_VOLATILITY[symbol] ?? 5.0;
        const now  = Math.floor(Date.now() / 1000);
        const out: Array<{ quote: number; epoch: number }> = [];
        let p = base;
        for (let i = count; i >= 0; i--) {
            p += (Math.random() - 0.5) * vol * 2;
            p = Math.max(p, vol * 0.1);
            out.push({ quote: p, epoch: now - i });
        }
        return out;
    }
}

export const ChartDataLayer = new ChartDataLayerClass();
