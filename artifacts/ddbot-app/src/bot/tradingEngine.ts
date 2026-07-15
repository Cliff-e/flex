// =============================================================
// TradingEngine — production-grade strategy engine
// Strategies: DIFFER | OVER_1 | UNDER_8
// Features: Martingale, exit-digit log, trade history
//
// Architecture: uses WebSocketManager (ONE authenticated WS) +
// EventBus for trade request/response, PublicTickManager for tick
// monitoring. No private WebSocket — no duplicate connections.
// =============================================================

import { getCurrentDCirclesState } from './dcirclesStore';
import { PublicTickManager } from '../utils/PublicTickManager';
import { WebSocketManager } from '../utils/WebSocketManager';
import { EventBus, EventMap } from '../utils/EventBus';
import { RuntimeLogger } from '../runtime/RuntimeLogger';

const AI_BOT_RUNTIME_ID = 'ai-bot';

const TRADES_PER_BATCH = 3;
const MIN_FREQ_TICKS = 50;
const ENTRY_DEBOUNCE_MS = 2500;
const TRADE_TIMEOUT_MS = 30_000;
const EXIT_DIGIT_LOG_LIMIT = 20;

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
    private tickDigits: number[] = [];
    private decimals: number | null = null;
    private virtualDigits: number[] = [];
    private realDigits: number[] = [];

    // Exit digit log (last 20, mixed virtual+real)
    private exitDigitLog: ExitDigitEntry[] = [];

    // Full trade history
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
        this.tickDigits = [];
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
        RuntimeLogger.stop(AI_BOT_RUNTIME_ID);
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

        const epoch: number = tick.epoch;
        if (this.lastTickEpoch === epoch) return;
        this.lastTickEpoch = epoch;

        if (this.decimals === null) {
            const str = String(tick.quote);
            this.decimals = (str.split('.')[1] ?? '').length || 2;
        }

        const digit = this.extractDigit(String(tick.quote));

        this.tickDigits.push(digit);
        if (this.tickDigits.length > 1000) this.tickDigits.shift();

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
        const storeState = getCurrentDCirclesState();
        const useStore =
            storeState.symbol === this.config.symbol && storeState.total >= MIN_FREQ_TICKS;

        const total = useStore ? storeState.total : this.tickDigits.length;
        if (total < MIN_FREQ_TICKS) return false;

        const freq: Record<number, number> = {};
        for (let i = 0; i < 10; i++) freq[i] = 0;

        if (useStore) {
            Object.assign(freq, storeState.freq);
        } else {
            this.tickDigits.forEach(d => (freq[d] = (freq[d] ?? 0) + 1));
        }

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

                try {
                    const result = await this.placeOneTrade('DIGITDIFF', barrier, this.config.stake);
                    this.addRealExitDigit(result.exitDigit, result.won);
                    this.recordTrade('DIGITDIFF', barrier, this.config.stake, result);
                    this.tradeCount++;
                    this.profit += result.profit;

                    if (result.won) {
                        this.log(
                            `✅ Entry ${i + 1}/10 WON | exit:${result.exitDigit} | P&L: +${result.profit.toFixed(2)}`
                        );
                    } else {
                        this.log(
                            `❌ Entry ${i + 1}/10 LOST | exit:${result.exitDigit} | P&L: ${result.profit.toFixed(2)}`
                        );
                    }

                    this.publishStatus();
                    this.checkTPSL();
                } catch (err) {
                    this.log(`❌ Entry ${i + 1}/10 error: ${(err as Error).message}`);
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
                this.profit += result.profit;
                this.applyMartingale(result.won);

                if (result.won) {
                    this.log(
                        `✅ ${label} WON | exit:${result.exitDigit} | P&L: +${result.profit.toFixed(2)}`
                    );
                } else {
                    this.log(
                        `❌ ${label} LOST | exit:${result.exitDigit} | P&L: ${result.profit.toFixed(2)} | next stake: $${this.currentStake.toFixed(2)}`
                    );
                    hadLoss = true;
                }

                this.publishStatus();
                this.checkTPSL();
                if (this._isStopped()) break;
            } catch (err) {
                this.log(`❌ ${label} error: ${(err as Error).message}`);
                hadLoss = true;
            }
        }

        this.log(
            `📦 Batch complete | session P&L: ${this.profit >= 0 ? '+' : ''}${this.profit.toFixed(2)}`
        );

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
            this.profit += result.profit;
            this.applyMartingale(result.won);

            if (result.won) {
                this.log(
                    `✅ Recovery WON | exit:${result.exitDigit} | P&L: +${result.profit.toFixed(2)}`
                );
            } else {
                this.log(
                    `❌ Recovery LOST | exit:${result.exitDigit} | P&L: ${result.profit.toFixed(2)}`
                );
            }

            this.publishStatus();
            this.checkTPSL();
        } catch (err) {
            this.log(`❌ Recovery error: ${(err as Error).message}`);
        }

        if (!this._isStopped()) {
            this.inRecovery = false;
            this.recoveryConfirmed = false;
            this.recoveryOver6Count = 0;
            this.executionLock = false;
            this.setState('monitoring');
            this.log('↩️ Recovery complete — back to monitoring');
        }
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
                symbol: this.config.symbol,
                barrier,
            },
            proposalReqId
        );

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

        const contractId = (buyMsg as any).buy?.contract_id ?? (buyMsg as any).buy?.contractId;
        if (!contractId) {
            console.error('[AI-BOT][TradingEngine] buy response had no contract_id field:', buyMsg);
            throw new Error(
                `Buy failed: ${(buyMsg as any).error?.message ?? 'no contract_id'}`
            );
        }

        WebSocketManager.send({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
        });

        return this._awaitSettlement(contractId);
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
                console.log(`[AI-BOT][TradingEngine] ${eventType} response matched req_id ${reqId}:`, msg);
                if ((msg as any).error) {
                    reject(new Error((msg as any).error.message || 'API error'));
                } else {
                    resolve(msg);
                }
            });

            console.log(`[AI-BOT][TradingEngine] sending ${eventType} req_id ${reqId}:`, payload);
            WebSocketManager.send({ ...payload, req_id: reqId });
        });
    }

    /**
     * Await settlement of a specific contract via EventBus.
     * Resolves when `is_sold` becomes truthy for this contract_id.
     */
    private _awaitSettlement(contractId: number): Promise<TradeResult> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                unsub();
                reject(new Error('Settlement timed out'));
            }, TRADE_TIMEOUT_MS);

            const unsub = EventBus.on('proposal_open_contract', msg => {
                const poc = (msg as any).proposal_open_contract;
                if (!poc || poc.contract_id !== contractId) return;
                if (poc.is_sold) {
                    unsub();
                    clearTimeout(timer);
                    const profit: number = poc.profit ?? 0;
                    RuntimeLogger.recordTrade(AI_BOT_RUNTIME_ID, poc);
                    RuntimeLogger.updatePosition(AI_BOT_RUNTIME_ID, '--');
                    resolve({
                        won: profit > 0,
                        profit,
                        exitDigit: this.extractDigit(String(poc.exit_tick ?? 0)),
                    });
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
            return;
        }

        if (this.profit <= -this.config.stopLoss) {
            this.log(`🛑 Stop Loss hit (${this.profit.toFixed(2)} / -${this.config.stopLoss})`);
            this.setState('stopped');
            this._cleanupSubscriptions();
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
            profit: result.profit,
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
