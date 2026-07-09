// Shared singleton store — DCircles.tsx writes here; TradingEngine reads here.
// Keeps the two modules decoupled while sharing live digit data.

export type DCirclesDigitInfo = {
    digit: number;
    count: number;
    percent: number;
};

export type DCirclesState = {
    symbol: string;
    digits: number[];
    freq: Record<number, number>;
    total: number;
    latestDigit: number | null;
    digitInfo: DCirclesDigitInfo[];
};

type Subscriber = (state: DCirclesState) => void;

const emptyState = (): DCirclesState => ({
    symbol: '',
    digits: [],
    freq: {},
    total: 0,
    latestDigit: null,
    digitInfo: [],
});

class DCirclesStore {
    private _state: DCirclesState = emptyState();
    private _subs = new Set<Subscriber>();

    update(state: DCirclesState): void {
        this._state = state;
        this._subs.forEach(cb => cb(state));
    }

    getState(): DCirclesState {
        return this._state;
    }

    subscribe(cb: Subscriber): () => void {
        this._subs.add(cb);
        return () => this._subs.delete(cb);
    }
}

export const dcirclesStore = new DCirclesStore();

export const subscribeToDCirclesUpdates = (cb: Subscriber): (() => void) =>
    dcirclesStore.subscribe(cb);

export const getCurrentDCirclesState = (): DCirclesState =>
    dcirclesStore.getState();
