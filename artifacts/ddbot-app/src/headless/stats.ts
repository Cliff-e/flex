/**
 * Per-bot statistics for the headless VPS bot runtime.
 *
 * RULES THIS MODULE ENFORCES
 * --------------------------
 *   - Nothing here is invented. Every counter is derived from a runtime event
 *     the existing trade engine actually emitted (see `recordContractEvent`).
 *   - Monitoring/UI events are NOT trades. Only a `contract.status` event whose
 *     id is `contract.sold` and which carries a numeric `profit` counts.
 *   - No credential, OTP value, generated source or environment value is ever
 *     written to `stats.json`. The file is plain operational metadata.
 *
 * `stats.json` lives inside the bot's own directory and is the only file the
 * backend reads to report live performance to the UI.
 */
import { renameSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { safeErrorText, secrets } from './redact';

/** Runtime/auth state of a bot process. Single vocabulary used by stats + UI. */
export type BotState = 'starting' | 'authenticated' | 'expired' | 'stopping' | 'stopped' | 'error';

export const BOT_STATES: readonly BotState[] = [
    'starting',
    'authenticated',
    'expired',
    'stopping',
    'stopped',
    'error',
];

export function isBotState(value: unknown): value is BotState {
    return typeof value === 'string' && (BOT_STATES as readonly string[]).includes(value);
}

/** Shape persisted to `<bot-dir>/stats.json`. */
export type BotStats = {
    botId: string;
    status: BotState;
    startedAt: string | null;
    lastActivityAt: string | null;
    lastTradeAt: string | null;
    trades: number;
    wins: number;
    losses: number;
    profit: number;
    /** Account currency reported by the trade engine, when known. */
    currency: string | null;
    uptimeSeconds: number;
    /** Last redacted error string, never a stack and never a credential. */
    error: string | null;
};

/** A `contract.status` payload as emitted by the existing trade engine. */
export type ContractStatusEvent = {
    id?: string;
    data?: unknown;
    contract?: Record<string, unknown>;
};

export function emptyStats(botId: string): BotStats {
    return {
        botId,
        status: 'starting',
        startedAt: null,
        lastActivityAt: null,
        lastTradeAt: null,
        trades: 0,
        wins: 0,
        losses: 0,
        profit: 0,
        currency: null,
        uptimeSeconds: 0,
        error: null,
    };
}

/**
 * Reads a stats file. Returns null when the file is missing or unreadable, so a
 * caller never has to distinguish "absent" from "corrupt" to stay safe.
 */
export function readStats(filePath: string): BotStats | null {
    try {
        if (!existsSync(filePath)) return null;
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<BotStats>;
        if (!parsed || typeof parsed !== 'object') return null;
        return { ...emptyStats(String(parsed.botId ?? '')), ...parsed } as BotStats;
    } catch {
        return null;
    }
}

/**
 * Writes a stats file atomically (temp file + rename), so the backend can never
 * read a half-written JSON document while the runtime is flushing.
 */
export function writeStats(filePath: string, stats: BotStats): void {
    const tempPath = `${filePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(stats, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, filePath);
}

export type StatsCollectorOptions = {
    botId: string;
    /** Absolute path of `stats.json`. When omitted the collector stays in-memory. */
    filePath?: string;
    /** How often a dirty state is flushed to disk. */
    flushIntervalMs?: number;
    /** Injectable clock - tests need deterministic uptime. */
    now?: () => number;
};

/**
 * Accumulates operational statistics for one bot and persists them to
 * `stats.json`.
 *
 * Counters are only ever advanced from real runtime events. There is deliberately
 * no `simulateTrade()`/`seed()` helper: a fabricated counter would make the UI
 * lie about money.
 */
export class StatsCollector {
    private readonly _botId: string;
    private readonly _filePath: string | null;
    private readonly _flushIntervalMs: number;
    private readonly _now: () => number;

    private _stats: BotStats;
    private _startedAtMs: number | null = null;
    private _dirty = false;
    private _timer: ReturnType<typeof setInterval> | null = null;

    /** Contract ids already counted, so a repeated POC message cannot double-count. */
    private readonly _countedContracts = new Set<string>();

    constructor(options: StatsCollectorOptions) {
        this._botId = options.botId;
        this._filePath = options.filePath ?? null;
        this._flushIntervalMs = options.flushIntervalMs ?? 2_000;
        this._now = options.now ?? (() => Date.now());
        this._stats = emptyStats(options.botId);
    }

    get botId(): string {
        return this._botId;
    }

    get status(): BotState {
        return this._stats.status;
    }

    /** Marks the moment the bot began starting; drives `startedAt`/`uptimeSeconds`. */
    markStarted(atMs?: number): void {
        if (this._startedAtMs !== null) return;
        this._startedAtMs = atMs ?? this._now();
        this._stats.startedAt = new Date(this._startedAtMs).toISOString();
        this._stats.lastActivityAt = this._stats.startedAt;
        this._dirty = true;
    }

    /**
     * Records a state transition. `error` is stored redacted and truncated -
     * never a stack, because a stack frame can contain generated source.
     */
    setStatus(status: BotState, options: { error?: unknown } = {}): void {
        this._stats.status = status;
        if (options.error !== undefined) {
            this._stats.error = safeErrorText(options.error);
        } else if (status !== 'error') {
            this._stats.error = null;
        }
        this._stats.lastActivityAt = new Date(this._now()).toISOString();
        this._dirty = true;
    }

    /** Notes non-trade activity (a tick was processed, a log line was emitted …). */
    markActivity(): void {
        this._stats.lastActivityAt = new Date(this._now()).toISOString();
        this._dirty = true;
    }


    /**
     * Feeds a `contract.status` event emitted by the existing trade engine.
     *
     * Returns true only when the event was a genuine settlement that advanced the
     * trade counters. `contract.purchase_sent` / `contract.purchase_received` /
     * open-contract updates are monitoring events and return false without
     * touching the counters - counting them would overstate the trade count.
     */
    recordContractEvent(event: ContractStatusEvent | null | undefined): boolean {
        if (!event || typeof event !== 'object') return false;

        this.markActivity();

        if (event.id !== 'contract.sold') return false;

        const contract = event.contract;
        if (!contract || typeof contract !== 'object') return false;

        const rawProfit = (contract as Record<string, unknown>).profit;
        // A settlement without a numeric profit is not a settlement we can
        // account for. Refusing it is better than writing a guessed number.
        if (typeof rawProfit !== 'number' || !Number.isFinite(rawProfit)) return false;

        const contractId = (contract as Record<string, unknown>).contract_id;
        if (contractId !== undefined && contractId !== null) {
            const key = String(contractId);
            if (this._countedContracts.has(key)) return false;
            this._countedContracts.add(key);
        }

        const currency = (contract as Record<string, unknown>).currency;
        this.recordTrade({
            profit: rawProfit,
            currency: typeof currency === 'string' ? currency : undefined,
        });
        return true;
    }

    /** Applies a single settled trade exactly as reported by Deriv. */
    recordTrade(trade: { profit: number; currency?: string }): void {
        if (!Number.isFinite(trade.profit)) return;

        const nowIso = new Date(this._now()).toISOString();
        this._stats.trades += 1;
        if (trade.profit > 0) this._stats.wins += 1;
        else if (trade.profit < 0) this._stats.losses += 1;
        // A zero-profit settlement is a genuine outcome (e.g. a scratch), but it
        // is neither a win nor a loss - so neither counter is advanced.
        this._stats.profit = Number((this._stats.profit + trade.profit).toFixed(8));
        this._stats.lastTradeAt = nowIso;
        this._stats.lastActivityAt = nowIso;
        if (trade.currency) this._stats.currency = trade.currency;
        this._dirty = true;
    }

    /** Current values, with `uptimeSeconds` recomputed from the injected clock. */
    snapshot(): BotStats {
        const uptimeSeconds =
            this._startedAtMs === null ? 0 : Math.max(0, Math.round((this._now() - this._startedAtMs) / 1000));
        return { ...this._stats, uptimeSeconds };
    }

    /** True when a flush would actually change the file. */
    get isDirty(): boolean {
        return this._dirty;
    }

    /** Begins periodic flushing. Safe to call more than once. */
    startAutoFlush(): void {
        if (this._timer || !this._filePath) return;
        this._timer = setInterval(() => this.flush(), this._flushIntervalMs);
        // Never hold the event loop open just to write stats.
        if (typeof this._timer.unref === 'function') this._timer.unref();
    }

    /** Writes the current snapshot to disk. */
    flush(): void {
        if (!this._filePath) return;
        const snapshot = this.snapshot();
        // Belt and braces: even a hand-built snapshot must not carry a credential.
        const serialised = secrets.redact(JSON.stringify(snapshot));
        writeStats(this._filePath, JSON.parse(serialised) as BotStats);
        this._dirty = false;
    }

    /** Stops the flush timer and performs a final write. */
    dispose(): void {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this.flush();
    }
}
