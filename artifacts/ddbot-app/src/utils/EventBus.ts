export type EventMap = {
    tick: { symbol: string; quote: number; epoch: number; [k: string]: unknown };
    balance: { balance: number; currency: string; [k: string]: unknown };
    transaction: unknown;
    proposal: { req_id?: number; proposal?: { id: string; [k: string]: unknown }; error?: { message: string }; [k: string]: unknown };
    buy: { req_id?: number; buy?: { contract_id: number; [k: string]: unknown }; error?: { message: string }; [k: string]: unknown };
    proposal_open_contract: { proposal_open_contract?: { contract_id: number; is_sold: number; profit: number; exit_tick: unknown; [k: string]: unknown }; [k: string]: unknown };
    'auth:success': { loginid: string; account_list: unknown[]; [k: string]: unknown };
    'auth:failed': { code?: string; message?: string; [k: string]: unknown };
    'auth:logout': undefined;
    'ws:connected': undefined;
    'ws:disconnected': undefined;
    'public:connected': undefined;
    'public:disconnected': undefined;
    'public:tick': { symbol: string; quote: number; epoch: number; [k: string]: unknown };
    'active_symbols:loaded': undefined;
    'chart:mode_changed': { mode: 'preview' | 'live' };
    error: unknown;
};

type Handler<T> = (data: T) => void;

class EventBusClass {
    private _listeners = new Map<string, Set<Handler<unknown>>>();

    on<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): () => void {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event)!.add(handler as Handler<unknown>);
        return () => this._listeners.get(event)?.delete(handler as Handler<unknown>);
    }

    once<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): () => void {
        let off: () => void;
        const wrapper: Handler<EventMap[K]> = data => {
            handler(data);
            off?.();
        };
        off = this.on(event, wrapper);
        return off;
    }

    emit<K extends keyof EventMap>(event: K, data?: EventMap[K]): void {
        this._listeners.get(event)?.forEach(h => {
            try { h(data as unknown); } catch {}
        });
    }

    off<K extends keyof EventMap>(event: K, handler?: Handler<EventMap[K]>): void {
        if (!handler) {
            this._listeners.delete(event);
        } else {
            this._listeners.get(event)?.delete(handler as Handler<unknown>);
        }
    }
}

export const EventBus = new EventBusClass();
