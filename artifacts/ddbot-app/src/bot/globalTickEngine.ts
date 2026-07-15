import { SYMBOLS } from '../pages/d-circles/symbols';
import { PublicTickManager } from '../utils/PublicTickManager';
import { dcirclesStore } from './dcirclesStore';

// ─────────────────────────────────────────────────────────────────────────────
// GlobalTickEngine — single source of truth for all digit/tick history.
//
// Architecture:
//   • ONE PublicTickManager subscription per symbol, shared across every
//     consumer (DCircles page, LiveDCirclesPanel, FloatingDCirclesWidget,
//     chart, DeepTrader, TradingEngine, future AI modules).
//   • Maintains a rolling buffer of up to `_limit` digits per symbol.
//   • Configurable limit (100–5000, default 3000) persisted to localStorage.
//     Call setLimit(n) to change it; all buffers are trimmed immediately.
//   • On every tick the engine also updates dcirclesStore for the currently
//     active symbol (localStorage key "dc_symbol") so TradingEngine always
//     has fresh confirmation data even when the DCircles UI is not open.
//   • Persists accumulated digits to localStorage between page loads so
//     consumers never need to wait for a "warm-up" period.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TICK_LIMIT = 1000;
const STORAGE_KEY = 'digitsMap';
const LIMIT_KEY = 'dc_tickLimit';

export type DigitsMap = Record<string, number[]>;
type TickCallback = (symbol: string, digits: number[]) => void;
type LimitCallback = (limit: number) => void;

class GlobalTickEngine {
    private digitsMap: DigitsMap = {};
    private decimals: Record<string, number> = {};
    private subscribers = new Set<TickCallback>();
    private _limitSubs = new Set<LimitCallback>();
    private started = false;
    private unsubFns: Array<() => void> = [];
    private _limit: number = DEFAULT_TICK_LIMIT;

    init() {
        if (this.started) return;
        this.started = true;

        // Restore persisted limit (clamped to valid range)
        try {
            const saved = localStorage.getItem(LIMIT_KEY);
            if (saved) {
                const n = Number(saved);
                if (n >= 100 && n <= 5000) this._limit = n;
            }
        } catch {}

        // Restore persisted digit history
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) this.digitsMap = JSON.parse(saved);
        } catch {
            this.digitsMap = {};
        }

        // ONE subscription per unique symbol — PublicTickManager deduplicates
        // the underlying WS send so this never creates duplicate connections.
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
            prev.length >= this._limit ? [...prev.slice(1), digit] : [...prev, digit];

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.digitsMap));
        } catch {}

        const digits = this.digitsMap[symbol];

        // Notify all JS subscribers (UI components, etc.)
        this.subscribers.forEach(cb => {
            try { cb(symbol, digits); } catch {}
        });

        // Keep dcirclesStore in sync for the currently-active symbol so that
        // TradingEngine confirmation checks are always fresh, even when the
        // DCircles page is not open. DCircles.tsx / LiveDCirclesPanel continue
        // to overwrite this with their own view-limited slice; that's fine —
        // they share the same store and always write more-recent data.
        try {
            const activeSymbol = localStorage.getItem('dc_symbol') || 'R_75';
            if (symbol === activeSymbol) {
                const total = digits.length || 1;
                const freq: Record<number, number> = {};
                for (let i = 0; i < 10; i++) freq[i] = 0;
                digits.forEach(d => { freq[d] = (freq[d] ?? 0) + 1; });
                const digitInfo = Array.from({ length: 10 }, (_, d) => ({
                    digit: d,
                    count: freq[d],
                    percent: (freq[d] / total) * 100,
                }));
                dcirclesStore.update({
                    symbol,
                    digits,
                    freq,
                    total,
                    latestDigit: digits.at(-1) ?? null,
                    digitInfo,
                });
            }
        } catch {}
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Returns a copy of the stored digits for the given symbol. */
    getDigits(symbol: string): number[] {
        return this.digitsMap[symbol] ? [...this.digitsMap[symbol]] : [];
    }

    /** Returns a copy of the full digits map (all symbols). */
    getAllDigits(): DigitsMap {
        const copy: DigitsMap = {};
        for (const sym in this.digitsMap) {
            copy[sym] = [...this.digitsMap[sym]];
        }
        return copy;
    }

    /** Current rolling-buffer limit (number of digits retained per symbol). */
    getLimit(): number {
        return this._limit;
    }

    /**
     * Set the global rolling-buffer limit (100–5000).
     * Immediately trims all existing buffers and notifies subscribers so
     * every consumer (UI and bot) sees the updated data right away.
     */
    setLimit(n: number): void {
        const clamped = Math.max(100, Math.min(5000, Math.round(n)));
        if (clamped === this._limit) return;
        this._limit = clamped;
        try { localStorage.setItem(LIMIT_KEY, String(clamped)); } catch {}

        // Trim all existing buffers to the new limit
        for (const sym in this.digitsMap) {
            if (this.digitsMap[sym].length > clamped) {
                this.digitsMap[sym] = this.digitsMap[sym].slice(-clamped);
            }
        }
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.digitsMap)); } catch {}

        // Notify all tick subscribers so UIs re-render immediately
        for (const sym in this.digitsMap) {
            const digits = this.digitsMap[sym];
            this.subscribers.forEach(cb => {
                try { cb(sym, digits); } catch {}
            });
        }

        // Notify limit-change subscribers so input controls stay in sync
        this._limitSubs.forEach(cb => {
            try { cb(clamped); } catch {}
        });
    }

    /** Subscribe to tick updates. Returns an unsubscribe function. */
    subscribe(cb: TickCallback): () => void {
        this.subscribers.add(cb);
        return () => this.subscribers.delete(cb);
    }

    /**
     * Subscribe to limit changes. Fires whenever setLimit() is called with a
     * new value — lets every DCircles UI keep its displayed input in sync even
     * when another consumer changes the limit.
     * Returns an unsubscribe function.
     */
    onLimitChange(cb: LimitCallback): () => void {
        this._limitSubs.add(cb);
        return () => this._limitSubs.delete(cb);
    }

    destroy() {
        this.unsubFns.forEach(fn => fn());
        this.unsubFns = [];
        this.subscribers.clear();
        this.started = false;
    }
}

export const globalTickEngine = new GlobalTickEngine();
