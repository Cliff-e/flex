import { SYMBOLS } from '../pages/d-circles/symbols';
import { PublicTickManager } from '../utils/PublicTickManager';

const TICK_LIMIT = 3000;
const STORAGE_KEY = 'digitsMap';

type DigitsMap = Record<string, number[]>;
type TickCallback = (symbol: string, digits: number[]) => void;

class GlobalTickEngine {
    private digitsMap: DigitsMap = {};
    private decimals: Record<string, number> = {};
    private subscribers = new Set<TickCallback>();
    private started = false;
    private unsubFns: Array<() => void> = [];

    init() {
        if (this.started) return;
        this.started = true;

        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) this.digitsMap = JSON.parse(saved);
        } catch {
            this.digitsMap = {};
        }

        const seen = new Set<string>();
        SYMBOLS.forEach(s => {
            if (seen.has(s.value)) return;
            seen.add(s.value);

            const unsub = PublicTickManager.subscribe(s.value, tick => {
                this._handleTick(tick.symbol, tick.quote);
            });
            this.unsubFns.push(unsub);
        });
    }

    private _handleTick(symbol: string, quote: number): void {
        let str = String(quote);
        if (str.includes('e')) str = Number(quote).toFixed(10);

        if (!this.decimals[symbol]) {
            const dec = (str.split('.')[1] || '').length;
            this.decimals[symbol] = dec || 2;
        }

        const normalized = Number(quote).toFixed(this.decimals[symbol]);
        const digit = Number(normalized.replace('.', '').slice(-1));

        const prev = this.digitsMap[symbol] || [];
        this.digitsMap[symbol] =
            prev.length >= TICK_LIMIT ? [...prev.slice(1), digit] : [...prev, digit];

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.digitsMap));
        } catch {}

        const digits = this.digitsMap[symbol];
        this.subscribers.forEach(cb => {
            try { cb(symbol, digits); } catch {}
        });
    }

    getDigits(symbol: string): number[] {
        return this.digitsMap[symbol] ? [...this.digitsMap[symbol]] : [];
    }

    getAllDigits(): DigitsMap {
        const copy: DigitsMap = {};
        for (const sym in this.digitsMap) {
            copy[sym] = [...this.digitsMap[sym]];
        }
        return copy;
    }

    subscribe(cb: TickCallback): () => void {
        this.subscribers.add(cb);
        return () => this.subscribers.delete(cb);
    }

    destroy() {
        this.unsubFns.forEach(fn => fn());
        this.unsubFns = [];
        this.subscribers.clear();
        this.started = false;
    }
}

export const globalTickEngine = new GlobalTickEngine();
