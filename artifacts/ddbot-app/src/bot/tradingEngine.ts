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

const AI_BOT_RUNTIME_ID = 'ai-bot';

// Set to true to re-enable verbose per-request / per-POC console tracing.
// Leave false in production — trades, errors and TP/SL are always logged.
const DEBUG_AI_BOT = false;

const TRADES_PER_BATCH = 3;
const MIN_FREQ_TICKS = 50;
const ENTRY_DEBOUNCE_MS = 2500;
const TRADE_TIMEOUT_MS = 30_000;
const EXIT_DIGIT_LOG_LIMIT = 20;

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
}

export interface TradeResult {
    won: boolean;
    profit: number;
    exitDigit: number;
}

export interface ExitDigitEntry {
    digit: number;
    source: 'virtual' | 'real';
    won?: boolean;
    ts: number;
}

export interface TradeRecord {
    id: number;
    ts: string;
    contractType: string;
    barrier: string;
    stake: number;
    exitDigit: number;
    won: boolean;
    profit: number;
}

export interface EngineStatus {
    state: EngineState;
    profit: number;
    trades: number;
    currentStake: number;
    exitDigitLog: ExitDigitEntry[];
    tradeHistory: TradeRecord[];
    logs: string[];
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

    // Martingale
    private currentStake = 0;

    // Digit streams
    // tickDigits removed — TradingEngine reads digit history directly from
    // globalTickEngine (the single shared source of truth) instead of
    // maintaining its own private buffer.
    private decimals: number | null = null;
    private virtualDigits: number[] = [];
    private realDigits: number[] = [];

    // Exit digit log (last 20, mixed virtual+real)
    private exitDigitLog: ExitDigitEntry[] = [];

    // Full trade history — kept locally for PerformanceDashboard/DigitHeatmap.
    // AI Bot trades are also forwarded to the shared TransactionsStore via
    // the observer bus, so there is ONE persistent source of truth for the
    // run-panel Summary / Transactions / Journal panels.
    private tradeHistory: TradeRecord[] = [];

    // Execution guards
    private executionLock = false;
    private lastEntryTs = 0;
    private lastTickEpoch: number | null = null;

    // Recovery state
    private inRecovery = false;
    private recoveryConfirmed = false;
    private recoveryOver6Count = 0;

    // Differ Sequence state
    private differCycleOffset = 0;

    // ── NEW: shared-resource handles (no private WebSocket) ──
    private _reqId = 0;
    private _tickUnsub: (() => void) | null = null;
    private _currentTradeReject: ((e: Error) => void) | null = null;

    // Callback resolved by executeRecoveryTrade when recovery finishes.
    // Used by runDifferSequenceLoop to await the shared recovery engine
    // without polling — the same engine used by OVER_1, UNDER_8, and DIFFER.
    private _onRecoveryComplete: (() => void) | null = null;

    // Logging
    private logs: string[] = [];
    private onStatus: ((s: EngineStatus) => void) | null = null;

    // ─────────────────────────────────────────
    // Constructor / lifecycle
    // ─────────────────────────────────────────

    constructor(private config: TradingConfig) {}

    setStatusCallback(cb: (s: EngineStatus) => void): void {
        this.onStatus = cb;
    }

    async start(): Promise<void> {
        if (this.state !== 'idle' && this.state !== 'stopped') return;

        this.profit = 0;
        this.tradeCount = 0;
        this.tradeIdCounter = 0;
        this.currentStake = this.config.stake;
        this.virtualDigits = [];
        this.realDigits = [];
        this.exitDigitLog = [];
        this.tradeHistory = [];
        this.executionLock = false;
        this.lastEntryTs = 0;
        this.lastTickEpoch = null;
        this.inRecovery = false;
        this.recoveryConfirmed = false;
        this.recoveryOver6Count = 0;
        this.differCycleOffset = 0;
        this.logs = [];
        this.decimals = null;

        RuntimeLogger.start(AI_BOT_RUNTIME_ID, {
            name: 'AI Bot',
            strategy: this.config.strategy,
            market: this.config.symbol,
        });

        this.log('🤖 Bot starting — virtual monitoring active');
        const mult = this.config.martingaleMultiplier;
        if (mult > 1) this.log(`📈 Martingale ×${mult} active`);
        this.setState('monitoring');

        // Notify the shared run-panel that a bot is now running so that
        // has_open_contract is set to true and the UI reacts accordingly.
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
        // Notify shared run-panel that the bot has stopped.
        observer.emit('bot.stop', undefined);
        RuntimeLogger.stop(AI_BOT_RUNTIME_ID);
        // Unblock any DIFFER_SEQUENCE loop that is awaiting recovery so it can
        // observe the stopped state and exit cleanly rather than hanging.
        const cb = this._onRecoveryComplete;
        this._onRecoveryComplete = null;
        cb?.();
    }

    // ─────────────────────────────────────────
    // Shared-resource connection (no private WS)
    // ─────────────────────────────────────────

    private async _connectToManagers(): Promise<void> {
        // Ensure the ONE shared authenticated WS is available for trade execution.
        await WebSocketManager.connect();
        this.log('🔗 Connected to shared WS — subscribing to ticks via PublicTickManager');

        // Use PublicTickManager (public WS, no auth) for tick monitoring.
        this._tickUnsub = PublicTickManager.subscribe(this.config.symbol, tick => {
            this.handleTick(tick as any);
        });
    }

    private _cleanupSubscriptions(): void {
        this._tickUnsub?.();
        this._tickUnsub = null;
        // WebSocketManager is shared — do NOT disconnect it here.
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

        // Read directly from the shared global engine — always current,
        // no dependency on any UI component being mounted or visible.
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
                    this.addRealExitDigit(result.exitDigit, result.won);
                    this.recordTrade('DIGITDIFF', barrier, this.config.stake, result);
                    this.tradeCount++;
                    // Use safe addition: result.profit is already a number after _awaitSettlement
                    // normalises it, but guard again for defence-in-depth.
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

                    // ── RECOVERY HOOK ─────────────────────────────────────────
                    // After a losing trade, pause the sequence and enter the
                    // same shared recovery engine used by OVER_1, UNDER_8 and
                    // DIFFER. _awaitRecovery() sets inRecovery=true and returns
                    // a Promise that resolves only when executeRecoveryTrade()
                    // completes — so the recovery path (DCircles confirmation +
                    // 3 OVER-6 digits + recovery trade) is identical for every
                    // strategy. The while-loop condition is re-checked after the
                    // await so a stop() during recovery exits cleanly.
                    if (!result.won && !this._isStopped()) {
                        await this._awaitRecovery();
                        if (!this._isStopped()) this.setState('executing');
                    }

                    if (DEBUG_AI_BOT) console.log(`[AI-BOT][LIFECYCLE] Next sequence entry — seq index ${i + 2}/10`);
                } catch (err) {
                    // A single trade error must NOT kill the entire sequence.
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

            const stakeForThisTrade = this.currentStake;
            const label = `Trade ${i + 1}/${TRADES_PER_BATCH}`;

            try {
                this.log(
                    `📡 ${label} — ${contractType} @ ${barrier}, stake $${stakeForThisTrade.toFixed(2)}`
                );
                const result = await this.placeOneTrade(contractType, barrier, stakeForThisTrade);

                this.addRealExitDigit(result.exitDigit, result.won);
                this.recordTrade(contractType, barrier, stakeForThisTrade, result);
                this.tradeCount++;
                // safeNum guard: result.profit is already normalised inside
                // _awaitSettlement, but this is a defence-in-depth measure.
                this.profit += safeNum(result.profit);
                this.applyMartingale(result.won);

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

                // Exit the batch immediately on the first loss so the very next
                // trade is the recovery trade — no further normal strategy trades.
                if (hadLoss) break;

                if (DEBUG_AI_BOT) console.log(`[AI-BOT][LIFECYCLE] Next trade — batch index ${i + 2}/${TRADES_PER_BATCH}`);
            } catch (err) {
                // A trade error counts as a loss — break immediately so the
                // very next trade is the recovery trade, not another strategy trade.
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
                this.log('🔄 Loss detected — entering recovery');
                this.inRecovery = true;
                this.recoveryConfirmed = false;
                this.recoveryOver6Count = 0;
            }
            this.executionLock = false;
            this.setState(this.inRecovery ? 'recovery' : 'monitoring');
        }
    }

    // ─────────────────────────────────────────
    // Recovery trade
    // ─────────────────────────────────────────

    private async executeRecoveryTrade(): Promise<void> {
        if (this.executionLock) return;
        this.executionLock = true;
        this.setState('executing');

        const { contractType, barrier } = this.resolveRecoveryContract();
        const stakeForRecovery = this.config.stake;
        this.log(
            `🔄 Recovery trade — ${contractType} @ ${barrier}, stake $${stakeForRecovery.toFixed(2)}`
        );

        try {
            const result = await this.placeOneTrade(contractType, barrier, stakeForRecovery);

            this.addRealExitDigit(result.exitDigit, result.won);
            this.recordTrade(contractType, barrier, stakeForRecovery, result);
            this.tradeCount++;
            this.profit += safeNum(result.profit);
            this.applyMartingale(result.won);

            if (result.won) {
                this.log(
                    `✅ Recovery WON | exit:${result.exitDigit} | P&L: +${this.profit.toFixed(2)}`
                );
            } else {
                this.log(
                    `❌ Recovery LOST | exit:${result.exitDigit} | P&L: ${this.profit.toFixed(2)}`
                );
            }

            this.publishStatus();
            this.checkTPSL();
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            this.log(`❌ Recovery error: ${msg}`);
            console.error('[AI-BOT][LIFECYCLE] Recovery trade error:', msg);
        }

        if (!this._isStopped()) {
            this.inRecovery = false;
            this.recoveryConfirmed = false;
            this.recoveryOver6Count = 0;
            this.executionLock = false;
            this.setState('monitoring');
            this.log('↩️ Recovery complete — back to monitoring');
        }

        // Notify any awaiting DIFFER_SEQUENCE loop that recovery is done
        // (resolved unconditionally so the loop can check _isStopped itself).
        const cb = this._onRecoveryComplete;
        this._onRecoveryComplete = null;
        cb?.();
    }

    /**
     * Used exclusively by runDifferSequenceLoop to plug into the shared
     * recovery engine (handleRecoveryTick → executeRecoveryTrade) without
     * polling. Sets all recovery state identically to what executeBatch does
     * for OVER_1, UNDER_8 and DIFFER, then returns a Promise that resolves
     * when executeRecoveryTrade signals completion via _onRecoveryComplete.
     */
    private _awaitRecovery(): Promise<void> {
        return new Promise<void>(resolve => {
            this._onRecoveryComplete = resolve;
            this.inRecovery = true;
            this.recoveryConfirmed = false;
            this.recoveryOver6Count = 0;
            this.setState('recovery');
            this.log('🔄 Loss detected — entering shared recovery engine');
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
    // Single trade — async, no private WS
    // ─────────────────────────────────────────

    private placeOneTrade(
        contractType: string,
        barrier: string,
        stake: number
    ): Promise<TradeResult> {
        return new Promise<TradeResult>((resolve, reject) => {
            // Store reject so stop() can abort immediately.
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

    private async _executeTrade(
        contractType: string,
        barrier: string,
        stake: number
    ): Promise<TradeResult> {
        const proposalReqId = ++this._reqId;

        // ── STAGE: purchase_sent ──────────────────────────────────────────────
        // Notify shared RunPanelStore so the contract-stage indicator updates.
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
                // api.derivws.com rejects `symbol` on proposal requests with
                // InputValidationFailed: "Properties not allowed: symbol" — it
                // requires `underlying_symbol` instead. Same fix already
                // applied in bot-skeleton's tradeOptionToProposal (helpers.js).
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

        // ── STAGE: purchase_received ──────────────────────────────────────────
        // The buy was acknowledged by the API. Notify RunPanelStore and feed
        // bot.info to the shared statistics (mirrors what Purchase.js does).
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
                // The new trading API (api.derivws.com) does not always echo
                // `req_id` at the top level of the response — same class of
                // issue already worked around for `passthrough` in
                // Proposal.js (bot-skeleton). Fall back to `echo_req.req_id`
                // so matching still works on both endpoint generations.
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
     * Resolves when `is_sold` becomes truthy for this contract_id.
     *
     * All numeric fields received from the Deriv API are coerced to
     * numbers via safeNum() immediately after normalizeContractSpots().
     * This prevents the class of crash where `.toFixed()` is called on
     * a string value returned by the new trading API endpoint.
     *
     * Also emits the same observer events as the Blockly engine so that
     * TransactionsStore, SummaryCardStore, JournalStore, and RunPanelStore
     * all receive live updates for AI Bot contracts.
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

                // ── NORMALISE: field names + numeric types ────────────────────
                // normalizeContractSpots handles field-name aliases
                // (camelCase ↔ snake_case). Then we explicitly coerce every
                // financial field to a number with safeNum() so arithmetic
                // operations never silently operate on strings.
                const poc = normalizeContractSpots(raw_poc) as any;

                poc.profit       = safeNum(poc.profit);
                poc.buy_price    = safeNum(poc.buy_price);
                poc.sell_price   = safeNum(poc.sell_price);
                poc.bid_price    = safeNum(poc.bid_price);
                poc.ask_price    = safeNum(poc.ask_price);
                poc.payout       = safeNum(poc.payout);
                poc.stake        = safeNum(poc.stake);
                poc.barrier      = poc.barrier;          // keep as string (digit barrier)
                poc.entry_tick   = poc.entry_tick;       // string/number — used for display
                poc.exit_tick    = poc.exit_tick;        // string/number — used for display
                poc.current_spot = safeNum(poc.current_spot);

                // ── BROADCAST: live updates to shared stores ──────────────────
                // Mirrors what OpenContract.js does in the Blockly engine.
                // Every TransactionsStore.onBotContractEvent and
                // SummaryCardStore.onBotContractEvent listener registered
                // through run_panel.registerBotListeners() will receive this.
                observer.emit('bot.contract', { ...poc });

                if (poc.is_sold) {
                    unsub();
                    clearTimeout(timer);

                    const profit = poc.profit;   // already a number after safeNum above

                    console.log(`[AI-BOT] Trade closed — ${profit >= 0 ? 'Profit' : 'Loss'}: ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}`);
                    if (DEBUG_AI_BOT) console.log('[AI-BOT][LIFECYCLE] Contract closed', {
                        contractId,
                        profit,
                        buy_price: poc.buy_price,
                        sell_price: poc.sell_price,
                        exit_tick: poc.exit_tick,
                        is_sold: poc.is_sold,
                    });

                    // ── STAGE: contract.sold → RunPanelStore contract stage ────
                    observer.emit('contract.status', {
                        id: 'contract.sold',
                        data: poc.transaction_ids?.sell,
                        contract: poc,
                    });

                    // ── STAGE: journal entry via shared JournalStore ──────────
                    // JournalStore.onLogSuccess is registered in RunPanelStore.onMount
                    // (always active), so this reliably reaches the Journal panel.
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

                    // Determine exit digit from the exit tick value.
                    // exit_tick may be a formatted string like "1234.56" or
                    // a number — extractDigit handles both.
                    const exitTickRaw = poc.exit_tick ?? poc.exit_spot ?? 0;
                    const exitDigit = this.extractDigit(String(exitTickRaw));

                    resolve({ won: profit > 0, profit, exitDigit });
                } else {
                    // Contract is open (not yet settled).
                    RuntimeLogger.updatePosition(
                        AI_BOT_RUNTIME_ID,
                        `${poc.contract_type ?? ''} @ ${poc.underlying ?? this.config.symbol}`.trim()
                    );
                }
            });
        });
    }

    // ─────────────────────────────────────────
    // Martingale
    // ─────────────────────────────────────────

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
            observer.emit('bot.stop', undefined);
            return;
        }

        if (this.profit <= -this.config.stopLoss) {
            this.log(`🛑 Stop Loss hit (${this.profit.toFixed(2)} / -${this.config.stopLoss})`);
            this.setState('stopped');
            this._cleanupSubscriptions();
            observer.emit('bot.stop', undefined);
        }
    }

    // ─────────────────────────────────────────
    // Digit tracking
    // ─────────────────────────────────────────

    private addVirtualExitDigit(d: number): void {
        this.virtualDigits.push(d);
        if (this.virtualDigits.length > 20) this.virtualDigits.shift();
        this.exitDigitLog.push({ digit: d, source: 'virtual', ts: Date.now() });
        if (this.exitDigitLog.length > EXIT_DIGIT_LOG_LIMIT) this.exitDigitLog.shift();
    }

    private addRealExitDigit(d: number, won: boolean): void {
        this.realDigits.push(d);
        if (this.realDigits.length > 20) this.realDigits.shift();
        this.exitDigitLog.push({ digit: d, source: 'real', won, ts: Date.now() });
        if (this.exitDigitLog.length > EXIT_DIGIT_LOG_LIMIT) this.exitDigitLog.shift();
    }

    private getLast20Digits(): number[] {
        return [...this.virtualDigits, ...this.realDigits].slice(-20);
    }

    private recordTrade(
        contractType: string,
        barrier: string,
        stake: number,
        result: TradeResult
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

    /**
     * Returns whether the engine is stopped.
     * Using a method (instead of direct property comparison inside while loops)
     * prevents TypeScript from narrowing `this.state` based on loop conditions
     * and incorrectly flagging post-await state checks as unreachable.
     */
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
            exitDigitLog: [...this.exitDigitLog],
            tradeHistory: [...this.tradeHistory],
            logs: [...this.logs],
        });
    }

    getStatus(): EngineStatus {
        return {
            state: this.state,
            profit: this.profit,
            trades: this.tradeCount,
            currentStake: this.currentStake,
            exitDigitLog: [...this.exitDigitLog],
            tradeHistory: [...this.tradeHistory],
            logs: [...this.logs],
        };
    }
}
