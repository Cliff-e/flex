/**
 * PublicTickManager — routes tick subscriptions through the dedicated
 * PublicMarketSocket (auth-free) instead of the shared trading socket.
 *
 * This ensures market data ticks are NEVER disrupted by auth state changes,
 * OTP expiry, or private socket reconnects.
 */
import { EventBus } from './EventBus';
import { PublicMarketSocket } from './PublicMarketSocket';

export type PublicTick = { symbol: string; quote: number; epoch: number };
type TickHandler = (tick: PublicTick) => void;

class PublicTickManagerClass {
    private _subscribers = new Map<string, Set<TickHandler>>();
    private _subscribedSymbols = new Set<string>();
    private _tickUnsub: (() => void) | null = null;
    private _wsConnectedUnsub: (() => void) | null = null;

    subscribe(symbol: string, handler: TickHandler): () => void {
        if (!this._subscribers.has(symbol)) {
            this._subscribers.set(symbol, new Set());
        }
        this._subscribers.get(symbol)!.add(handler);

        console.log('[PublicTickManager] subscribe:', symbol, '| total handlers:', this._subscribers.get(symbol)!.size);

        this._ensureEventBusListener();
        this._ensureWsReconnectListener();
        this._ensureSubscribed(symbol);

        return () => {
            this._subscribers.get(symbol)?.delete(handler);
            console.log('[PublicTickManager] unsubscribed handler for', symbol);
        };
    }

    private _ensureEventBusListener(): void {
        if (this._tickUnsub) return;
        // Listen to public:tick (from PublicMarketSocket) — not the private 'tick' event
        this._tickUnsub = EventBus.on('public:tick', tick => {
            const sym = tick?.symbol as string;
            const handlers = this._subscribers.get(sym);
            if (!handlers?.size) return;
            const pubTick: PublicTick = {
                symbol: sym,
                quote: tick.quote as number,
                epoch: tick.epoch as number,
            };
            handlers.forEach(h => {
                try { h(pubTick); } catch { /* ignore handler errors */ }
            });
        });
    }

    private _ensureWsReconnectListener(): void {
        if (this._wsConnectedUnsub) return;
        // Re-subscribe all symbols when the PUBLIC socket reconnects
        this._wsConnectedUnsub = EventBus.on('public:connected', () => {
            console.log('[PublicTickManager] public:connected — re-subscribing', this._subscribedSymbols.size, 'symbols');
            this._subscribedSymbols.clear();
            this._subscribers.forEach((handlers, sym) => {
                if (handlers.size > 0) this._ensureSubscribed(sym);
            });
        });
    }

    private _ensureSubscribed(symbol: string): void {
        if (this._subscribedSymbols.has(symbol)) return;
        if (!PublicMarketSocket.isConnected()) {
            console.log('[PublicTickManager] Public WS not ready yet for', symbol, '— will retry on public:connected');
            return;
        }
        this._subscribedSymbols.add(symbol);
        console.log('[PublicTickManager] sending ticks subscribe for', symbol);
        try {
            PublicMarketSocket.send({ ticks: symbol, subscribe: 1 });
        } catch (e) {
            console.error('[PublicTickManager] send failed for', symbol, e);
            this._subscribedSymbols.delete(symbol);
        }
    }
}

export const PublicTickManager = new PublicTickManagerClass();
