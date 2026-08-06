// =============================================================
// TradingEngine — production-grade strategy engine
// Strategies: DIFFER | OVER_1 | UNDER_8
// Features: Martingale, exit-digit log, trade history
//
// Architecture: uses WebSocketManager (ONE authenticated WS) +
// EventBus for trade request/response, PublicTickManager for tick
// monitoring. No private WebSocket — no duplicate connections.
//
// Shared infrastructure: emits the same observer events as the
// Blockly Bot Builder engine so that TransactionsStore,
// SummaryCardStore, JournalStore and RunPanelStore all receive
// AI Bot trades via the same bus they already listen on.
// =============================================================

import { PublicTickManager } from '../utils/PublicTickManager';
import { globalTickEngine } from './globalTickEngine';
import { WebSocketManager } from '../utils/WebSocketManager';
import { EventBus, EventMap } from '../utils/EventBus';
import { VirtualHookEngine, VHDecision } from './virtualHook';
import { getVHTransactionPipeline } from './virtualHook/VHRuntime';
import type { VHConfig } from './virtualHook/VHConfig';
import { DEFAULT_VH_CONFIG, resolveVHConfig } from './virtualHook/VHConfig';
import { AIProposalAdapter } from './virtualHook/adapters/AIProposalAdapter';
import { AITickObserver } from './virtualHook/adapters/AITickObserver';
import { RuntimeLogger } from '../runtime/RuntimeLogger';
import { LogTypes } from '../external/bot-skeleton';
// observer is the Blockly-compatible global event bus shared with
// RunPanelStore, TransactionsStore, SummaryCardStore, and JournalStore.
import { observer } from '../external/bot-skeleton/utils/observer';
// normalizeContractSpots/normalizeContractFinancials ensure that
// camelCase / renamed fields from the new trading API are normalised
// to the legacy snake_case field names expected by every downstream
// consumer (Transactions table, Summary card, Journal, CSV export).
import { normalizeContractSpots } from '../external/bot-skeleton/services/tradeEngine/utils/normalize-contract';
import {
    appendExitDigit,
    resetExitDigitHistory,
    getExitDigitHistory,
    getLastNConfirmedDigits,
    type ExitDigitEntry,
} from './sharedExitDigitHistory';

const AI_BOT_RUNTIME_ID = 'ai-bot';

// Set to true to re-enable verbose per-request / per-POC console tracing.
// Leave false in production — trades, errors and TP/SL are always logged.
const DEBUG_AI_BOT = false;

const TRADES_PER_BATCH = 3;
const MIN_FREQ_TICKS = 50;
const ENTRY_DEBOUNCE_MS = 2500;
const TRADE_TIMEOUT_MS = 30_000;
// EXIT_DIGIT_LOG_LIMIT removed — history cap is now owned by sharedExitDigitHistory.ts

// ─────────────────────────────────────────────
// Safe numeric coercion
// ─────────────────────────────────────────────

/**
 * Converts any value to a finite number.
 * The new Deriv trading API (api.derivws.com) returns many numeric
 * fields — profit, buy_price, sell_price, payout, bid_price, etc. —
 * as *strings* rather than numbers. Performing `+=` on a string
 * silently degrades to string concatenation (e.g. `0 + "0.35"` →
 * `"00.35"`), which then causes `TypeError: this.profit.toFixed is
 * not a function` when we later call `.toFixed(2)`. Using this helper
 * on every field coming out of the API prevents that class of crash
 * across the entire engine.
 */
function safeNum(v: unknown, fallback = 0): number {
    const n = Number(v);
    return isFinite(n) ? n : fallback;
}

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

export type Strategy = 'DIFFER' | 'DIFFER_SEQUENCE' | 'OVER_1' | 'UNDER_8';
export type EngineState = 'idle' | 'monitoring' | 'executing' | 'recovery' | 'stopped';

export interface TradingConfig {
    strategy: Strategy;
    symbol: string;
    stake: number;
    martingaleMultiplier: number;
    targetProfit: number;
    stopLoss: number;
    differDigits?: number[];
    /** Virtual Hook configuration — when enabled, all trades must pass the VH gate. */
    vhConfig?: Partial<VHConfig>;
}

export interface TradeResult {
    won: boolean;
    profit: number;
    exitDigit: number;
}

// ExitDigitEntry is now the canonical type in sharedExitDigitHistory.ts.
// Re-exported here so existing imports in AiBots.tsx remain unchanged.
export type { ExitDigitEntry } from './sharedExitDigitHistory';

export interface TradeRecord {
    id: number;
    ts: string;
    contractType: string;
    barrier: string;
    stake: number;
    exitDigit: number;
    won: boolean;
    profit: number;
    /** Distinguishes strategy trades from recovery trades for labelling in the UI. */
    tradeType: 'strategy' | 'recovery';
}

export interface EngineStatus {
    state: EngineState;
    profit: number;
    trades: number;
    currentStake: number;
    exitDigitLog: ExitDigitEntry[];
    tradeHistory: TradeRecord[];
    logs: string[];
    /** Total number of recovery trades executed this session. */
    recoveryTradeCount: number;
    /** Total number of recovery trades that resulted in a win. */
    recoveryWinCount: number;
    /** Whether the Virtual Hook gate is currently enabled (AI session). */
    vhEnabled: boolean;
    /** Whether the Virtual Hook engine is actively evaluating a signal. */
    vhActive: boolean;
}

// ─────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────

export class TradingEngine {
    // Session state
    private state: EngineState = 'idle';
    private profit = 0;
    private tradeCount = 0;
    private tradeIdCounter = 0;

    // Martingale — recovery-scoped. Strategy trades always use config.stake.
    private currentStake = 0;

    // Digit streams
    private decimals: number | null = null;

    // Full trade history — kept locally for PerformanceDashboard/DigitHeatmap.
    private tradeHistory: TradeRecord[] = [];

    // Execution guards
    private executionLock = false;
    private lastEntryTs = 0;
    private lastTickEpoch: number | null = null;

    // Recovery state
    private inRecovery = false;
    private recoveryConfirmed = false;
    private recoveryOver6Count = 0;
    private recoveryTradeCount = 0;
    private recoveryWinCount = 0;

    // Differ Sequence state
    private differCycleOffset = 0;

    // ── Shared-resource handles (no private WebSocket) ──
    private _reqId = 0;
    private _tickUnsub: (() => void) | null = null;
    private _currentTradeReject: ((e: Error) => void) | null = null;

    // Callback resolved by executeRecoveryTrade when recovery finishes.
    private _onRecoveryComplete: (() => void) | null = null;

    // ── Virtual Hook engine (single lazy instance per session) ──
    private _vhEngine: VirtualHookEngine | null = null;
    private _vhConfig: VHConfig = DEFAULT_VH_CONFIG;

    // Logging
    private logs: string[] = [];
    private onStatus: ((s: EngineStatus) => void) | null = null;

    // ─────────────────────────────────────────
    // Journal notify
    // ─────────────────────────────────────────
    private _journalNotify(message: string): void {
        observer.emit('ui.log.notify', { message, className: 'ai-bot-event' });
    }

    // ─────────────────────────────────────────
    // Constructor / lifecycle
    // ─────────────────────────────────────────

    constructor(private config: TradingConfig) {}

    setStatusCallback(cb: (s: EngineStatus) => void): void {
        this.onStatus = cb;
    }

    /**
     * Enable or disable the Virtual Hook gate for this AI session.
     *
     * Reuses the existing single VirtualHookEngine instance via the frozen
     * `configure({ enabled })` API — no new VH instance, no duplicated
     * configuration state, AI-Bot only (the XML engine is a separate
     * instance and is unaffected).
     *
     * The change is applied ONLY while the engine is idle/monitoring and
     * the VH engine is not mid-evaluation. During an active run the toggle
     * is rejected and logged rather than risking an in-flight authorization
     * with a changed policy.
     *
     * @returns true when the toggle was applied, false otherwise.
     */
    setVHEnabled(enabled: boolean): boolean {
        if (this.state === 'executing' || this.state === 'recovery') {
            this.log(`⚠️ VH toggle rejected — session is ${this.state}; allow change while idle/monitoring`);
            return false;
        }

        const engine = this._ensureVHEngine();
        const active = engine.getStatus().active;
        if (active) {
            this.log('⚠️ VH toggle rejected — Virtual Hook is actively evaluating a signal');
            return false;
        }

        engine.configure({ enabled });
        this._vhConfig = resolveVHConfig({ ...this._vhConfig, enabled });
        this.log(`🛡 Virtual Hook ${enabled ? 'ENABLED' : 'DISABLED'} (live toggle)`);
        this.publishStatus();
        return true;
    }

    async start(): Promise<void> {
        if (this.state !== 'idle' && this.state !== 'stopped') return;

        this.profit = 0;
        this.tradeCount = 0;
        this.tradeIdCounter = 0;
        this.currentStake = this.config.stake;
        resetExitDigitHistory();
        this.tradeHistory = [];
        this.executionLock = false;
        this.lastEntryTs = 0;
        this.lastTickEpoch = null;
        this.inRecovery = false;
        this.recoveryConfirmed = false;
        this.recoveryOver6Count = 0;
        this.recoveryTradeCount = 0;
        this.recoveryWinCount = 0;
        this.differCycleOffset = 0;
        this.logs = [];
        this.decimals = null;

        // Dispose any previous VH engine before recreating (prevents
        // leaked observer subscriptions across session restarts).
        this._disposeVHEngine();
        // Initialize VH config from TradingConfig overrides (always safe —
        // DEFAULT_VH_CONFIG.enabled === false so the gate is inert by default).
        // resolveVHConfig validates and clamps the merged values, rejecting
        // impossible combinations (minWins > maxSteps) early.
        this._vhConfig = resolveVHConfig(this.config.vhConfig ?? {});

        // Eagerly construct the VirtualHookEngine for this session so the
        // gate is ready before the first trade signal arrives.  _ensureVHEngine
        // is idempotent — it returns the existing instance on subsequent calls
        // — so _executeTrade() and setVHEnabled() safely reuse the same engine.
        this._ensureVHEngine();

        RuntimeLogger.start(AI_BOT_RUNTIME_ID, {
            name: 'AI Bot',
            strategy: this.config.strategy,
            market: this.config.symbol,
        });

        this.log('🤖 Bot starting — virtual monitoring active');
        if (this._vhConfig.enabled) {
            this.log(
                `🛡 Virtual Hook enabled — maxSteps=${this._vhConfig.maxSteps} minWins=${this._vhConfig.minWins} virtualStake=${this._vhConfig.virtualStake}`
            );
        }
        const mult = this.config.martingaleMultiplier;
        if (mult > 1) this.log(`📈 Recovery martingale ×${mult} active`);
        this.setState('monitoring');

        observer.emit('bot.running', undefined);

        try {
            await this._connectToManagers();
            if (this.config.strategy === 'DIFFER_SEQUENCE') {
                await this.runDifferSequenceLoop();
            }
        } catch (err) {
            this.log(`❌ Startup failed: ${(err as Error).message}`);
            this.setState('stopped');
        }
    }

    stop(): void {
        this.log('🛑 Session stopped by user');
        this.setState('stopped');
        this._cleanupSubscriptions();
        if (this._currentTradeReject) {
            this._currentTradeReject(new Error('Bot stopped'));
            this._currentTradeReject = null;
        }
        // Dispose the Virtual Hook engine — releases adapters, tick
        // subscriptions, timers, and any pending proposal waits so no
        // VH resources survive the session teardown.
        this._disposeVHEngine();
        observer.emit('bot.stop', undefined);
        RuntimeLogger.stop(AI_BOT_RUNTIME_ID);
        const cb = this._onRecoveryComplete;
        this._onRecoveryComplete = null;
        cb?.();
    }

    // ─────────────────────────────────────────
    // Shared-resource connection (no private WS)
    // ─────────────────────────────────────────

    private async _connectToManagers(): Promise<void> {
        await WebSocketManager.connect();
        this.log('🔗 Connected to shared WS — subscribing to ticks via PublicTickManager');

        this._tickUnsub = PublicTickManager.subscribe(this.config.symbol, tick => {
            this.handleTick(tick as any);
        });
    }

    private _cleanupSubscriptions(): void {
        this._tickUnsub?.();
        this._tickUnsub = null;
    }

    /**
     * Dispose the Virtual Hook engine if one was constructed.
     * Safe to call multiple times — dispose is idempotent on null.
     */
    private _disposeVHEngine(): void {
        const engine = this._vhEngine;
        this._vhEngine = null;
        if (engine) {
            engine.dispose().catch(err => {
                this.log(`⚠️ VH dispose error: ${(err as Error)?.message ?? String(err)}`);
            });
        }
    }

    // ─────────────────────────────────────────
    // Tick handler
    // ─────────────────────────────────────────

    private handleTick(tick: any): void {
        if (this.state === 'stopped' || this.state === 'idle') return;

        const epoch: number = safeNum(tick.epoch);
        if (this.lastTickEpoch === epoch) return;
        this.lastTickEpoch = epoch;

        if (this.decimals === null) {
            const str = String(tick.quote);
            this.decimals = (str.split('.')[1] ?? '').length || 2;
        }

        const digit = this.extractDigit(String(tick.quote));

        if (this.state === 'monitoring' && !this.executionLock) {
            this.addVirtualExitDigit(digit);
        }

        if (this.inRecovery) {
            this.handleRecoveryTick(digit);
            return;
        }

        if (
            this.state === 'monitoring' &&
            !this.executionLock &&
            this.config.strategy !== 'DIFFER_SEQUENCE'
        ) {
            const now = Date.now();
            if (now - this.lastEntryTs < ENTRY_DEBOUNCE_MS) return;

            if (!this.checkDCirclesConfirmation()) return;

            const { triggered, entryDigit } = this.detectEntry(digit);
            if (!triggered) return;

            this.log(`🎯 Entry detected — digit ${digit} | Confirmation ✅`);
            if (DEBUG_AI_BOT) console.log('[AI-BOT][LIFECYCLE] Proposal matched — entry digit', digit, '| strategy', this.config.strategy);
            RuntimeLogger.updateSignal(AI_BOT_RUNTIME_ID, `Entry on digit ${digit}`);
            this._journalNotify(`👁 [VIRTUAL] Entry signal — digit ${digit} — strategy ${this.config.strategy} — executing real trade`);
            this.lastEntryTs = now;
            this.currentEntryDigit = entryDigit;
            void this.executeBatch();
        }
    }

    // ─────────────────────────────────────────
    // Recovery tick handler
    // ─────────────────────────────────────────

    private handleRecoveryTick(digit: number): void {
        if (this.executionLock) return;

        if (!this.recoveryConfirmed) {
            if (!this.checkDCirclesConfirmation()) return;
            this.recoveryConfirmed = true;
            this.log('🔄 Recovery: DCircles confirmed — waiting for 3 OVER 6 digits');
        }

        if (digit > 6) {
            this.recoveryOver6Count++;
            this.log(`🔄 Recovery: OVER 6 digit (${digit}) — ${this.recoveryOver6Count}/3`);
        }

        if (this.recoveryOver6Count >= 3) {
            this.log('🔄 Recovery condition met — executing recovery trade');
            void this.executeRecoveryTrade();
        }
    }

    // ─────────────────────────────────────────
    // DCircles confirmation
    // ─────────────────────────────────────────

    private checkDCirclesConfirmation(): boolean {
        const { strategy } = this.config;

        const digits = globalTickEngine.getDigits(this.config.symbol);
        const total = digits.length;
        if (total < MIN_FREQ_TICKS) return false;

        const freq: Record<number, number> = {};
        for (let i = 0; i < 10; i++) freq[i] = 0;
        digits.forEach(d => { freq[d] = (freq[d] ?? 0) + 1; });

        const pct = (d: number) => ((freq[d] ?? 0) / total) * 100;
        const hasRedBar = (d: number) => pct(d) > 12;

        if (strategy === 'OVER_1') {
            return pct(0) < 10.5 && pct(1) < 10.5 && !hasRedBar(0) && !hasRedBar(1);
        }
        if (strategy === 'UNDER_8') {
            return pct(8) < 10.5 && pct(9) < 10.5 && !hasRedBar(8) && !hasRedBar(9);
        }
        return total >= MIN_FREQ_TICKS;
    }

    // ─────────────────────────────────────────
    // Differ Sequence helpers
    // ─────────────────────────────────────────

    private computeDifferSequence(): number[] {
        const d2 = (3 + this.differCycleOffset) % 10;
        const seq: number[] = [0, d2];
        for (let i = 2; i < 10; i++) {
            seq.push((seq[i - 1] * 2 + 3) % 10);
        }
        return seq;
    }

    private async runDifferSequenceLoop(): Promise<void> {
        this.log('🎯 Differ Sequence mode active — firing auto-sequence');
        this.setState('executing');

        while (!this._isStopped()) {
            const seq = this.computeDifferSequence();
            const d2 = (3 + this.differCycleOffset) % 10;
            this.log(
                `🔄 Cycle ${this.differCycleOffset + 1} — sequence: 0 → ${d2} → ${seq.slice(2).join(' → ')}`
            );

            for (let i = 0; i < seq.length; i++) {
                if (this._isStopped()) break;

                const barrier = String(seq[i]);
                this.log(
                    `📡 Entry ${i + 1}/10 — DIFFER @ ${barrier}, stake $${this.config.stake.toFixed(2)}`
                );
                if (DEBUG_AI_BOT) console.log(`[AI-BOT][LIFECYCLE] Auto-sequence entry ${i + 1}/10 — DIFFER barrier:${barrier}`);

                try {
                    const result = await this.placeOneTrade('DIGITDIFF', barrier, this.config.stake);
                    this.recordTrade('DIGITDIFF', barrier, this.config.stake, result);
                    this.tradeCount++;
                    this.profit += safeNum(result.profit);

                    if (result.won) {
                        this.log(
                            `✅ Entry ${i + 1}/10 WON | exit:${result.exitDigit} | P&L: +${this.profit.toFixed(2)}`
                        );
                    } else {
                        this.log(
                            `❌ Entry ${i + 1}/10 LOST | exit:${result.exitDigit} | P&L: ${this.profit.toFixed(2)}`
                        );
                    }

                    this.publishStatus();
                    this.checkTPSL();

                    if (!result.won && !this._isStopped()) {
                        await this._awaitRecovery();
                        if (!this._isStopped()) this.setState('executing');
                    }

                    if (DEBUG_AI_BOT) console.log(`[AI-BOT][LIFECYCLE] Next sequence entry — seq index ${i + 2}/10`);
                } catch (err) {
                    this.log(`❌ Entry ${i + 1}/10 error: ${(err as Error).message}`);
                    console.error('[AI-BOT][LIFECYCLE] Sequence entry error (continuing):', (err as Error).message);
                }

                if (this._isStopped()) break;
            }

            if (this._isStopped()) break;

            const nextD2 = (3 + this.differCycleOffset + 1) % 10;
            this.log(
                `⏸ Cycle ${this.differCycleOffset + 1} complete — refreshing (next d2 = ${nextD2})`
            );
            this.differCycleOffset++;
            await new Promise<void>(r => setTimeout(r, 1500));
        }
    }

    // ─────────────────────────────────────────
    // Entry detection
    // ─────────────────────────────────────────

    private currentEntryDigit = 0;

    private detectEntry(digit: number): { triggered: boolean; entryDigit: number } {
        const { strategy } = this.config;

        switch (strategy) {
            case 'OVER_1':
                return { triggered: digit === 5 || digit === 6, entryDigit: digit };
            case 'UNDER_8':
                return { triggered: digit === 7 || digit === 4 || digit === 9, entryDigit: digit };
            case 'DIFFER': {
                const digits = this.config.differDigits?.length ? this.config.differDigits : [];
                return { triggered: digits.includes(digit), entryDigit: digit };
            }
            default:
                return { triggered: false, entryDigit: digit };
        }
    }

    // ─────────────────────────────────────────
    // Contract config
    // ─────────────────────────────────────────

    private getContractConfig(): { contractType: string; barrier: string } {
        switch (this.config.strategy) {
            case 'OVER_1':
                return { contractType: 'DIGITOVER', barrier: '1' };
            case 'UNDER_8':
                return { contractType: 'DIGITUNDER', barrier: '8' };
            case 'DIFFER':
            case 'DIFFER_SEQUENCE':
                return { contractType: 'DIGITDIFF', barrier: String(this.currentEntryDigit) };
        }
    }

    // ─────────────────────────────────────────
    // Batch execution (3 sequential trades)
    // ─────────────────────────────────────────

    private async executeBatch(): Promise<void> {
        if (this.executionLock) {
            this.log('⚠️ Batch skipped — execution lock active');
            return;
        }

        this.executionLock = true;
        this.setState('executing');

        const { contractType, barrier } = this.getContractConfig();
        this.log(`📦 Batch start — ${contractType} barrier:${barrier} × ${TRADES_PER_BATCH}`);

        let hadLoss = false;

        for (let i = 0; i < TRADES_PER_BATCH; i++) {
            if (this._isStopped()) break;

            // Normal strategy trades ALWAYS use the configured base stake.
            // Martingale progression applies ONLY while recovery mode is
            // active (see _enterRecoveryMode / executeRecoveryTrade), so it
            // can never leak back into normal strategy trading.
            const stakeForThisTrade = this.config.stake;
            const label = `Trade ${i + 1}/${TRADES_PER_BATCH}`;

            try {
                this.log(
                    `📡 ${label} — ${contractType} @ ${barrier}, stake $${stakeForThisTrade.toFixed(2)}`
                );
                const result = await this.placeOneTrade(contractType, barrier, stakeForThisTrade);

                this.recordTrade(contractType, barrier, stakeForThisTrade, result);
                this.tradeCount++;
                this.profit += safeNum(result.profit);

                if (result.won) {
                    this.log(
                        `✅ ${label} WON | exit:${result.exitDigit} | P&L: +${this.profit.toFixed(2)}`
                    );
                } else {
                    this.log(
                        `❌ ${label} LOST | exit:${result.exitDigit} | P&L: ${this.profit.toFixed(2)} | next stake: ${this.currentStake.toFixed(2)}`
                    );
                    hadLoss = true;
                }

                this.publishStatus();
                this.checkTPSL();
                if (this._isStopped()) break;

                if (hadLoss) break;

                if (DEBUG_AI_BOT) console.log(`[AI-BOT][LIFECYCLE] Next trade — batch index ${i + 2}/${TRADES_PER_BATCH}`);
            } catch (err) {
                const msg = (err as Error).message ?? String(err);
                this.log(`❌ ${label} error: ${msg}`);
                console.error('[AI-BOT][LIFECYCLE] Trade error in executeBatch (continuing):', msg);
                hadLoss = true;
                break;
            }
        }

        this.log(
            `📦 Batch complete | session P&L: ${this.profit >= 0 ? '+' : ''}${this.profit.toFixed(2)}`
        );
        if (DEBUG_AI_BOT) console.log('[AI-BOT][LIFECYCLE] Batch complete | P&L:', this.profit.toFixed(2));

        if (!this._isStopped()) {
            if (hadLoss) {
                this.log('🔄 Loss detected — suspending strategy, entering recovery');
                this._journalNotify(
                    `🔄 [RECOVERY] Activated — original strategy (${this.config.strategy}) suspended — waiting for DCircles + 3×OVER-6`
                );
                this._enterRecoveryMode();
            }
            this.executionLock = false;
            this.setState(this.inRecovery ? 'recovery' : 'monitoring');
        }
    }

    // ─────────────────────────────────────────
    // Recovery mode
    // ─────────────────────────────────────────

    /**
     * Enter recovery mode: strategy pauses immediately, recovery stays active
     * until a win, and the martingale progression begins from the base stake.
     * Recovery is a temporary override — a win resets martingale and resumes
     * the original strategy.
     */
    private _enterRecoveryMode(): void {
        this.inRecovery = true;
        this.recoveryConfirmed = false;
        this.recoveryOver6Count = 0;
        // Martingale starts from the configured base stake on the first
        // recovery attempt, then escalates per loss until a recovery win.
        this.currentStake = this.config.stake;
    }

    // ─────────────────────────────────────────
    // Recovery trade
    // ─────────────────────────────────────────

    private async executeRecoveryTrade(): Promise<void> {
        if (this.executionLock) return;
        this.executionLock = true;
        this.setState('executing');

        const { contractType, barrier } = this.resolveRecoveryContract();
        const stakeForRecovery = this.currentStake;
        this.recoveryTradeCount++;

        this.log(
            `🔄 Recovery trade #${this.recoveryTradeCount} — ${contractType} @ ${barrier}, stake ${stakeForRecovery.toFixed(2)}`
        );
        this._journalNotify(
            `🔄 [RECOVERY #${this.recoveryTradeCount}] ${contractType} @ ${barrier} — stake ${stakeForRecovery.toFixed(2)}`
        );

        let recoveryWon = false;
        try {
            const result = await this.placeOneTrade(contractType, barrier, stakeForRecovery);

            this.recordTrade(contractType, barrier, stakeForRecovery, result, 'recovery');
            this.tradeCount++;
            this.profit += safeNum(result.profit);
            this.applyMartingale(result.won);
            recoveryWon = result.won;

            if (result.won) {
                this.recoveryWinCount++;
                this.log(
                    `✅ Recovery WON | exit:${result.exitDigit} | P&L: +${this.profit.toFixed(2)}`
                );
                this._journalNotify(
                    `✅ [RECOVERY] WON — exit digit ${result.exitDigit} — returning to ${this.config.strategy}`
                );
            } else {
                this.log(
                    `❌ Recovery LOST | exit:${result.exitDigit} | P&L: ${this.profit.toFixed(2)} | next stake: ${this.currentStake.toFixed(2)}`
                );
                this._journalNotify(
                    `❌ [RECOVERY] LOST — exit ${result.exitDigit} — escalating to ${this.currentStake.toFixed(2)} — awaiting next signal`
                );
            }

            this.publishStatus();
            this.checkTPSL();
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            this.log(`❌ Recovery error: ${msg}`);
            console.error('[AI-BOT][LIFECYCLE] Recovery trade error:', msg);
            recoveryWon = false;
        }

        if (!this._isStopped()) {
            if (recoveryWon) {
                this.inRecovery = false;
                this.recoveryConfirmed = false;
                this.recoveryOver6Count = 0;
                this.currentStake = this.config.stake;
                this.executionLock = false;
                this.setState('monitoring');
                this.log(`↩️ Recovery complete (${this.recoveryTradeCount} trade(s)) — back to monitoring`);
                this._journalNotify(
                    `↩️ [RECOVERY] Complete — ${this.config.strategy} resumed after ${this.recoveryTradeCount} recovery trade(s)`
                );
                const cb = this._onRecoveryComplete;
                this._onRecoveryComplete = null;
                cb?.();
            } else {
                this.recoveryConfirmed = false;
                this.recoveryOver6Count = 0;
                this.executionLock = false;
                this.setState('recovery');
            }
        } else {
            const cb = this._onRecoveryComplete;
            this._onRecoveryComplete = null;
            cb?.();
        }
    }

    private _awaitRecovery(): Promise<void> {
        return new Promise<void>(resolve => {
            this._onRecoveryComplete = resolve;
            this._enterRecoveryMode();
            this.setState('recovery');
            this.log('🔄 Loss detected — entering shared recovery engine');
            this._journalNotify(
                `🔄 [RECOVERY] Activated — DIFFER_SEQUENCE suspended — waiting for DCircles + 3×OVER-6`
            );
        });
    }

    private resolveRecoveryContract(): { contractType: string; barrier: string } {
        const last20 = this.getLast20Digits();
        if (last20.length === 0) return { contractType: 'DIGITOVER', barrier: '5' };

        const over5Count = last20.filter(d => d >= 5).length;
        const under4Count = last20.filter(d => d < 4).length;
        const over5Pct = (over5Count / last20.length) * 100;
        const under4Pct = (under4Count / last20.length) * 100;

        if (over5Pct > 60) {
            this.log(`🔄 Recovery decision: ${over5Pct.toFixed(0)}% OVER 5 → UNDER 4`);
            return { contractType: 'DIGITUNDER', barrier: '4' };
        }
        if (under4Pct > 60) {
            this.log(`🔄 Recovery decision: ${under4Pct.toFixed(0)}% UNDER 4 → OVER 5`);
            return { contractType: 'DIGITOVER', barrier: '5' };
        }
        this.log('🔄 Recovery decision: default → OVER 5');
        return { contractType: 'DIGITOVER', barrier: '5' };
    }

    // ─────────────────────────────────────────
    // Single trade — gate through Virtual Hook
    // ─────────────────────────────────────────

    private placeOneTrade(
        contractType: string,
        barrier: string,
        stake: number
    ): Promise<TradeResult> {
        return new Promise<TradeResult>((resolve, reject) => {
            this._currentTradeReject = reject;

            this._executeTrade(contractType, barrier, stake)
                .then(result => {
                    this._currentTradeReject = null;
                    resolve(result);
                })
                .catch(err => {
                    this._currentTradeReject = null;
                    reject(err);
                });
        });
    }

    /**
     * Execute a funded trade, optionally gated by VirtualHookEngine.
     *
     * When VH is enabled:
     *   1. Build a TradeCandidate (source:'ai').
     *   2. Submit to VirtualHookEngine.start().
     *   3. AUTHORIZED → proceed to _executeRealTrade.
     *   4. REJECTED / STOPPED → throw (treated as trade failure by callers).
     *   5. RETRY → re-submit VH only (bounded loop, never re-runs strategy).
     *
     * When VH is disabled: proceeds directly to _executeRealTrade.
     * This is identical behaviour to Purchase.js running without VH.
     */
    private async _executeTrade(
        contractType: string,
        barrier: string,
        stake: number
    ): Promise<TradeResult> {
        // ── VH disabled → exact legacy behaviour ──
        if (!this._vhConfig.enabled) {
            return this._executeRealTrade(contractType, barrier, stake);
        }

        this.log(
            `🛡 VH gate — ${contractType} @ ${barrier} stake=${stake}`
        );

        const engine = this._ensureVHEngine();

        // ── RETRY loop (VH only, strategy never re-evaluated) ──
        const maxRetries = this._vhConfig.aiMaxRetries;
        let retries = 0;

        for (;;) {
            const candidate = this._buildTradeCandidate(contractType, barrier, stake);
            let result;
            try {
                result = await engine.start(candidate);
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                this.log(`❌ VH engine error: ${reason}`);
                throw new Error(`VH engine error: ${reason}`);
            }

            this.log(
                `🛡 VH decision: ${result.decision} | reason=${result.reason} | rounds=${result.roundsCompleted} wins=${result.wins}`
            );

            if (result.decision === VHDecision.AUTHORIZED) {
                return this._executeRealTrade(contractType, barrier, stake);
            }

            if (result.decision === VHDecision.REJECTED) {
                this.log(`🚫 VH REJECTED: ${result.reason}`);
                throw new Error(`VH REJECTED: ${result.reason}`);
            }

            if (result.decision === VHDecision.STOPPED) {
                this.log(`⏹ VH STOPPED: ${result.reason}`);
                throw new Error(`VH STOPPED: ${result.reason}`);
            }

            // RETRY — retry the VH gate only
            retries++;
            if (retries >= maxRetries) {
                this.log(`⚠️ VH RETRY exhausted (${maxRetries} max)`);
                throw new Error(`VH RETRY exhausted after ${maxRetries} attempts`);
            }
            this.log(`🔄 VH RETRY ${retries}/${maxRetries}`);
        }
    }

    /**
     * The real trade pipeline — proposal → buy → settlement.
     *
     * This is the original _executeTrade body extracted intact.
     * It is invoked directly when VH is disabled, or after VH
     * returns AUTHORIZED. Zero logic changes.
     */
    private async _executeRealTrade(
        contractType: string,
        barrier: string,
        stake: number
    ): Promise<TradeResult> {
        const proposalReqId = ++this._reqId;

        observer.emit('contract.status', {
            id: 'contract.purchase_sent',
            data: stake,
        });
        console.log(`[AI-BOT] Trade opened — ${contractType} barrier:${barrier} stake:${stake}`);
        if (DEBUG_AI_BOT) console.log('[AI-BOT][LIFECYCLE] BUY sent — contractType:', contractType, 'barrier:', barrier, 'stake:', stake);

        const proposalMsg = await this._sendAndAwait(
            'proposal',
            {
                proposal: 1,
                amount: String(stake),
                basis: 'stake',
                contract_type: contractType,
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                underlying_symbol: this.config.symbol,
                barrier,
            },
            proposalReqId
        );

        if (DEBUG_AI_BOT) console.log('[AI-BOT][LIFECYCLE] Proposal response received — req_id:', proposalReqId);

        const proposalId = (proposalMsg as any).proposal?.id ?? (proposalMsg as any).proposal?.proposalId;
        if (!proposalId) {
            console.error('[AI-BOT][TradingEngine] proposal response had no id field:', proposalMsg);
            throw new Error('No proposal ID returned');
        }

        const buyReqId = ++this._reqId;
        const buyMsg = await this._sendAndAwait(
            'buy',
            { buy: proposalId, price: stake },
            buyReqId
        );

        const rawBuy = (buyMsg as any).buy;
        const contractId = rawBuy?.contract_id ?? rawBuy?.contractId;
        if (!contractId) {
            console.error('[AI-BOT][TradingEngine] buy response had no contract_id field:', buyMsg);
            throw new Error(
                `Buy failed: ${(buyMsg as any).error?.message ?? 'no contract_id'}`
            );
        }

        if (DEBUG_AI_BOT) console.log('[AI-BOT][LIFECYCLE] Buy response received — contract_id:', contractId);

        const normalizedBuy = {
            contract_id: contractId,
            transaction_id: safeNum(rawBuy?.transaction_id ?? rawBuy?.transactionId),
            buy_price: safeNum(rawBuy?.buy_price ?? rawBuy?.buyPrice),
            payout: safeNum(rawBuy?.payout ?? rawBuy?.payoutAmount),
            longcode: rawBuy?.longcode ?? '',
            shortcode: rawBuy?.shortcode ?? '',
            start_time: safeNum(rawBuy?.start_time ?? rawBuy?.startTime),
        };

        observer.emit('contract.status', {
            id: 'contract.purchase_received',
            data: normalizedBuy.transaction_id,
            buy: normalizedBuy,
        });

        observer.emit('bot.info', {
            totalRuns: this.tradeCount + 1,
            transaction_ids: { buy: normalizedBuy.transaction_id },
            contract_type: contractType,
            buy_price: normalizedBuy.buy_price,
        });

        if (DEBUG_AI_BOT) console.log('[AI-BOT][LIFECYCLE] Contract opened — contract_id:', contractId);

        WebSocketManager.send({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
        });

        return this._awaitSettlement(contractId, stake);
    }

    /**
     * Send a request through the shared WS and await the matching response
     * via EventBus, filtered by req_id. Rejects on timeout.
     */
    private _sendAndAwait(
        eventType: 'proposal' | 'buy',
        payload: object,
        reqId: number
    ): Promise<EventMap['proposal'] | EventMap['buy']> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                unsub();
                reject(new Error(`Trade timed out waiting for ${eventType}`));
            }, TRADE_TIMEOUT_MS);

            const unsub = EventBus.on(eventType, msg => {
                const msgReqId = (msg as any).req_id ?? (msg as any).echo_req?.req_id;
                if (msgReqId !== reqId) {
                    this.log(
                        `↩️ ${eventType} response ignored — req_id ${msgReqId ?? '(none)'} ≠ expected ${reqId}`
                    );
                    return;
                }
                unsub();
                clearTimeout(timer);
                if (DEBUG_AI_BOT) console.log(`[AI-BOT][TradingEngine] ${eventType} response matched req_id ${reqId}:`, msg);
                if ((msg as any).error) {
                    reject(new Error((msg as any).error.message || 'API error'));
                } else {
                    resolve(msg);
                }
            });

            if (DEBUG_AI_BOT) console.log(`[AI-BOT][TradingEngine] sending ${eventType} req_id ${reqId}:`, payload);
            WebSocketManager.send({ ...payload, req_id: reqId });
        });
    }

    /**
     * Await settlement of a specific contract via EventBus.
     */
    private _awaitSettlement(contractId: number, _stake: number): Promise<TradeResult> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                unsub();
                reject(new Error('Settlement timed out'));
            }, TRADE_TIMEOUT_MS);

            const unsub = EventBus.on('proposal_open_contract', msg => {
                const raw_poc = (msg as any).proposal_open_contract;
                if (!raw_poc || raw_poc.contract_id !== contractId) return;

                const poc = normalizeContractSpots(raw_poc) as any;

                poc.profit       = safeNum(poc.profit);
                poc.buy_price    = safeNum(poc.buy_price);
                poc.sell_price   = safeNum(poc.sell_price);
                poc.bid_price    = safeNum(poc.bid_price);
                poc.ask_price    = safeNum(poc.ask_price);
                poc.payout       = safeNum(poc.payout);
                poc.stake        = safeNum(poc.stake);
                poc.barrier      = poc.barrier;
                poc.entry_tick   = poc.entry_tick;
                poc.exit_tick    = poc.exit_tick;
                poc.current_spot = safeNum(poc.current_spot);

                observer.emit('bot.contract', { ...poc });

                if (poc.is_sold) {
                    unsub();
                    clearTimeout(timer);

                    const profit = poc.profit;

                    console.log(`[AI-BOT] Trade closed — ${profit >= 0 ? 'Profit' : 'Loss'}: ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}`);
                    if (DEBUG_AI_BOT) console.log('[AI-BOT][LIFECYCLE] Contract closed', {
                        contractId,
                        profit,
                        buy_price: poc.buy_price,
                        sell_price: poc.sell_price,
                        exit_tick: poc.exit_tick,
                        is_sold: poc.is_sold,
                    });

                    observer.emit('contract.status', {
                        id: 'contract.sold',
                        data: poc.transaction_ids?.sell,
                        contract: poc,
                    });

                    observer.emit('ui.log.success', {
                        log_type: profit > 0 ? LogTypes.PROFIT : LogTypes.LOST,
                        extra: { currency: poc.currency || 'USD', profit },
                    });

                    if (DEBUG_AI_BOT) {
                        console.log('[AI-BOT][LIFECYCLE] Summary updated — profit:', profit);
                        console.log('[AI-BOT][LIFECYCLE] Journal updated — type:', profit > 0 ? 'PROFIT' : 'LOST');
                        console.log('[AI-BOT][LIFECYCLE] Transactions updated — contract_id:', contractId);
                    }

                    RuntimeLogger.recordTrade(AI_BOT_RUNTIME_ID, poc);
                    RuntimeLogger.updatePosition(AI_BOT_RUNTIME_ID, '--');

                    const exitTickRaw = poc.exit_tick ?? poc.exit_spot ?? 0;
                    const exitDigit = this.extractDigit(String(exitTickRaw));

                    resolve({ won: profit > 0, profit, exitDigit });
                } else {
                    RuntimeLogger.updatePosition(
                        AI_BOT_RUNTIME_ID,
                        `${poc.contract_type ?? ''} @ ${poc.underlying ?? this.config.symbol}`.trim()
                    );
                }
            });
        });
    }

    // ─────────────────────────────────────────
    // Virtual Hook helpers
    // ─────────────────────────────────────────

    /**
     * Lazily construct the single VirtualHookEngine for this AI session.
     */
    private _ensureVHEngine(): VirtualHookEngine {
        if (this._vhEngine) return this._vhEngine;

        const proposalAdapter = new AIProposalAdapter({
            send: payload => WebSocketManager.send(payload),
            onProposalResponse: (event, cb) => EventBus.on(event as any, cb as any) as any,
            getSymbol: () => this.config.symbol,
        });

        const tickObserver = new AITickObserver();

        this._vhEngine = new VirtualHookEngine(
            proposalAdapter,
            tickObserver,
            getVHTransactionPipeline()
        );

        // Apply config overrides that were set before engine creation.
        if (this._vhConfig) {
            this._vhEngine.configure(this._vhConfig);
        }

        return this._vhEngine;
    }

    /**
     * Build a TradeCandidate from the current AI trade context.
     * Uses exactly the same model consumed by VirtualHookEngine.
     */
    private _buildTradeCandidate(
        contractType: string,
        barrier: string,
        stake: number
    ): import('./virtualHook/TradeCandidate').TradeCandidate {
        return {
            signalId: `ai-${++this._reqId}-${Date.now()}`,
            source: 'ai',
            contractType,
            symbol: this.config.symbol,
            realStake: stake,
            duration: 1,
            durationUnit: 't',
            currency: 'USD',
            basis: 'stake',
            prediction: barrier ? Number(barrier) : null,
            tradeParams: { barrier },
            generatedAt: Date.now(),
        };
    }

    // ─────────────────────────────────────────
    // Martingale — recovery-scoped only
    // ─────────────────────────────────────────

    /**
     * Apply the martingale progression. Called ONLY from recovery trades.
     * A recovery win resets to the base stake (recovery ends); a recovery
     * loss escalates for the next recovery attempt.
     */
    private applyMartingale(won: boolean): void {
        const mult = this.config.martingaleMultiplier;
        if (mult <= 1) return;

        if (won) {
            if (this.currentStake !== this.config.stake) {
                this.log(`📈 Martingale reset → $${this.config.stake.toFixed(2)}`);
            }
            this.currentStake = this.config.stake;
        } else {
            this.currentStake = parseFloat((this.currentStake * mult).toFixed(2));
            this.log(`📈 Martingale → next stake $${this.currentStake.toFixed(2)}`);
        }
    }

    // ─────────────────────────────────────────
    // TP / SL
    // ─────────────────────────────────────────

    private checkTPSL(): void {
        if (this.state === 'stopped') return;

        if (this.profit >= this.config.targetProfit) {
            this.log(
                `🎯 Take Profit reached (${this.profit.toFixed(2)} / +${this.config.targetProfit})`
            );
            this.setState('stopped');
            this._cleanupSubscriptions();
            // Release the Virtual Hook engine resources on the TP stop path.
            this._disposeVHEngine();
            observer.emit('bot.stop', undefined);
            return;
        }

        if (this.profit <= -this.config.stopLoss) {
            this.log(`🛑 Stop Loss hit (${this.profit.toFixed(2)} / -${this.config.stopLoss})`);
            this.setState('stopped');
            this._cleanupSubscriptions();
            // Release the Virtual Hook engine resources on the SL stop path.
            this._disposeVHEngine();
            observer.emit('bot.stop', undefined);
        }
    }

    // ─────────────────────────────────────────
    // Digit tracking
    // ─────────────────────────────────────────

    private addVirtualExitDigit(d: number): void {
        appendExitDigit({ digit: d, source: 'virtual', ts: Date.now() });
    }

    /**
     * Recovery reads ONLY confirmed exit digits committed through the
     * canonical Transactions panel pipeline (`source: 'real'`). Monitoring
     * ticks (`source: 'virtual'`) and VH-virtual (`source: 'vh_virtual'`)
     * digits are NEVER used for recovery decisions — recovery must never
     * operate on speculative or unconfirmed data.
     */
    private getLast20Digits(): number[] {
        return getLastNConfirmedDigits(20);
    }

    private recordTrade(
        contractType: string,
        barrier: string,
        stake: number,
        result: TradeResult,
        tradeType: 'strategy' | 'recovery' = 'strategy'
    ): void {
        this.tradeHistory.push({
            id: ++this.tradeIdCounter,
            ts: new Date().toLocaleTimeString(),
            contractType,
            barrier,
            stake,
            exitDigit: result.exitDigit,
            won: result.won,
            profit: safeNum(result.profit),
            tradeType,
        });
    }

    // ─────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────

    private extractDigit(raw: string): number {
        if (this.decimals !== null && this.decimals > 0) {
            const normalized = Number(raw).toFixed(this.decimals);
            return Number(normalized.replace('.', '').slice(-1));
        }
        return Number(String(raw).replace('.', '').slice(-1));
    }

    private setState(next: EngineState): void {
        this.state = next;
        this.publishStatus();
    }

    private _isStopped(): boolean {
        return this.state === 'stopped';
    }

    private log(msg: string): void {
        const ts = new Date().toLocaleTimeString();
        const line = `[${ts}] ${msg}`;
        this.logs.push(line);
        if (this.logs.length > 200) this.logs.shift();
        this.publishStatus();

        const level = msg.includes('❌') || msg.includes('🛑') || msg.includes('failed')
            ? 'ERROR'
            : msg.includes('✅') || msg.includes('💰')
              ? 'SUCCESS'
              : 'INFO';
        RuntimeLogger.log(level, msg, AI_BOT_RUNTIME_ID);
    }

    private publishStatus(): void {
        this.onStatus?.({
            state: this.state,
            profit: this.profit,
            trades: this.tradeCount,
            currentStake: this.currentStake,
            exitDigitLog: getExitDigitHistory(),
            tradeHistory: [...this.tradeHistory],
            logs: [...this.logs],
            recoveryTradeCount: this.recoveryTradeCount,
            recoveryWinCount: this.recoveryWinCount,
            vhEnabled: this._vhConfig.enabled,
            vhActive: this._vhEngine?.getStatus().active ?? false,
        });
    }

    getStatus(): EngineStatus {
        return {
            state: this.state,
            profit: this.profit,
            trades: this.tradeCount,
            currentStake: this.currentStake,
            exitDigitLog: getExitDigitHistory(),
            tradeHistory: [...this.tradeHistory],
            logs: [...this.logs],
            recoveryTradeCount: this.recoveryTradeCount,
            recoveryWinCount: this.recoveryWinCount,
            vhEnabled: this._vhConfig.enabled,
            vhActive: this._vhEngine?.getStatus().active ?? false,
        };
    }
}