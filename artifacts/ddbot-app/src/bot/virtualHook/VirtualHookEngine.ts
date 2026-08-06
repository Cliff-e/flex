// =============================================================
// VirtualHookEngine — The single execution gateway
//
// Every trading engine (XML, AI, Speedbot, future) submits a
// normalized TradeCandidate through this ONE engine.
//
// The engine:
//   1. Validates the candidate.
//   2. Runs virtual contract rounds through the state machine.
//   3. Settles each round via the canonical SettlementEngine.
//   4. Records outcomes through the TransactionPipeline.
//   5. Evaluates accumulated outcomes via VirtualPolicy.
//   6. Returns exactly one of: AUTHORIZED | REJECTED | RETRY | STOPPED.
//
// This engine NEVER calls buy(). It is purely an authorization
// decision engine. Only the real execution layer performs funded
// purchases.
// =============================================================

import { VHDecision } from './VHDecision';
import type { TradeCandidate } from './TradeCandidate';
import { isTradeCandidate } from './TradeCandidate';
import type { VHConfig } from './VHConfig';
import { resolveVHConfig } from './VHConfig';
import type { VirtualContract } from './VirtualContract';
import { VirtualContractFactory } from './VirtualContract';
import { settleDigitContract, isDigitContract } from './SettlementEngine';
import { VirtualPolicy } from './VirtualPolicy';
import type { ProposalAdapter, VHProposal } from './ProposalAdapter';
import type { TickObserver, VHTick } from './TickObserver';
import type { TransactionPipeline } from './TransactionPipeline';
import { NoopTransactionPipeline } from './TransactionPipeline';
import type { VHLogger } from './VHLogger';
import { ConsoleVHLogger } from './VHLogger';
import { VirtualStateMachine, VHState } from './VirtualStateMachine';
import {
    InvalidTradeCandidateError,
    ProposalError,
    SettlementTimeoutError,
    VirtualHookBusyError,
    VirtualHookError,
} from './errors';

/**
 * Timeout used for waiting for the entry tick.
 */
const DEFAULT_ENTRY_TICK_TIMEOUT_MS = 30_000;

/**
 * The final result of a Virtual Hook evaluation.
 */
export interface VHStartResult {
    /** The decision for the caller. */
    decision: VHDecision;

    /** Reason associated with the decision. */
    reason: string;

    /** Number of virtual rounds completed. */
    roundsCompleted: number;

    /** Number of virtual wins. */
    wins: number;

    /** Number of virtual losses. */
    losses: number;
}

/**
 * A complete record of one virtual round run.
 */
interface RoundResult {
    /** The contract used for this round. */
    contract: VirtualContract;

    /** Whether the round completed successfully (won or lost). */
    ok: boolean;

    /** True if the virtual contract was a win (only set when ok=true). */
    won: boolean;

    /** The timestamp of contract settlement. */
    settledAt: number;
}

/**
 * The Virtual Hook execution gateway.
 *
 * This is the ONLY Virtual Hook implementation in the repository.
 * Every trading engine reuses it.
 *
 * Lifecycle:
 *   construct → configure (optional) → start (0..N times) → dispose
 *
 * dispose() is terminal — the engine cannot be reused after it is
 * called. This guarantees no lingering adapters, observers, timers,
 * or subscriptions survive a bot session teardown.
 */
export class VirtualHookEngine {
    private readonly _config: VHConfig;
    private readonly _logger: VHLogger;
    private readonly _proposalAdapter: ProposalAdapter;
    private readonly _tickObserver: TickObserver;
    private readonly _pipeline: TransactionPipeline;
    private readonly _policy: VirtualPolicy;

    private _currentRunId: string | null = null;
    private _busy = false;
    private _runAbortRequested = false;
    private _disposed = false;

    // Observability — last settled contract reference for run-completion logs.
    private _lastContractId: string | null = null;
    private _lastRoundIndex: number | null = null;

    // Total proposal retries across the run (for run-completion logs).
    private _proposalRetriesTotal = 0;

    /**
     * Construct the engine with explicit dependencies.
     *
     * @param proposalAdapter - Acquires proposals (XML: api_base, AI: WebSocketManager).
     * @param tickObserver    - Observes market ticks (shared tick infra).
     * @param pipeline        - Recording pipeline. Phase 1 defaults to Noop.
     * @param logger          - Structured logger.
     * @param overrides       - Optional config overrides.
     */
    constructor(
        proposalAdapter: ProposalAdapter,
        tickObserver: TickObserver,
        pipeline: TransactionPipeline = new NoopTransactionPipeline(),
        logger: VHLogger = new ConsoleVHLogger(),
        overrides?: Partial<VHConfig>
    ) {
        this._proposalAdapter = proposalAdapter;
        this._tickObserver = tickObserver;
        this._pipeline = pipeline;
        this._logger = logger;
        this._config = resolveVHConfig(overrides);
        this._policy = new VirtualPolicy(this._config);
    }

    /**
     * Whether this engine is enabled for execution.
     * Engines that call start() when disabled should short-circuit
     * to VHDecision.AUTHORIZED (immediately execute the real trade).
     */
    isEnabled(): boolean {
        return this._config.enabled;
    }

    /**
     * Update configuration after construction.
     * Safe to call between runs (never mid-run).
     *
     * Overrides are merged over the CURRENT configuration — not the
     * defaults — so a partial update never resets fields that were
     * previously configured.
     */
    configure(overrides: Partial<VHConfig>): void {
        if (this._disposed) {
            this._logger.error('vh.configure_rejected', {
                runId: this._currentRunId ?? 'none',
                currentState: VHState.IDLE,
                expectedState: VHState.IDLE,
                reason: 'Cannot reconfigure a disposed engine.',
                timeout: null,
                retryCount: null,
                recoveryAction: 'Create a new engine instance.',
            });
            return;
        }
        if (this._busy) {
            this._logger.error('vh.configure_rejected', {
                runId: this._currentRunId ?? 'none',
                currentState: VHState.ACTIVE,
                expectedState: VHState.IDLE,
                reason: 'Cannot reconfigure while a run is in progress.',
                timeout: null,
                retryCount: null,
                recoveryAction: 'Configure after the current run completes.',
            });
            return;
        }
        // Merge over the current config so partial overrides never
        // reset previously-set fields back to defaults.
        Object.assign(this._config, resolveVHConfig({ ...this._config, ...overrides }));
        Object.assign(this._policy, { _config: this._config });
    }

    /**
     * Current policy snapshot (counters, etc.) for status display.
     */
    getStatus(): { active: boolean; steps: number; wins: number; maxSteps: number; minWins: number } {
        return {
            active: this._busy,
            steps: this._policy.roundsCompleted,
            wins: this._policy.wins,
            maxSteps: this._config.maxSteps,
            minWins: this._config.minWins,
        };
    }

    /**
     * Abort any in-progress run. The engine will return STOPPED.
     * Safe to call from any context.
     */
    abort(): void {
        this._runAbortRequested = true;
    }

    /**
     * The primary entry point — evaluate a trade candidate.
     *
     * @param candidate - Normalized TradeCandidate from any engine.
     * @returns The authorization decision.
     */
    async start(candidate: TradeCandidate): Promise<VHStartResult> {
        if (this._disposed) {
            throw new VirtualHookError('VirtualHookEngine has been disposed.', {
                currentState: VHState.IDLE,
                expectedState: VHState.TRADE_CANDIDATE_RECEIVED,
                recoveryAction: 'Create a new engine instance.',
            });
        }
        if (this._busy) {
            throw new VirtualHookBusyError();
        }
        this._busy = true;
        this._runAbortRequested = false;
        this._policy.reset();
        this._proposalRetriesTotal = 0;
        this._lastContractId = null;
        this._lastRoundIndex = null;

        const runStartedAt = Date.now();
        const runId = candidate.signalId;
        this._currentRunId = runId;

        const sm = new VirtualStateMachine(this._logger, runId);

        // ── TRADE_CANDIDATE_RECEIVED ──────────────────────────────
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'start() called');

        if (!isTradeCandidate(candidate)) {
            const err = new InvalidTradeCandidateError('TradeCandidate failed structural validation.');
            this._logger.error('vh.invalid_candidate', {
                runId,
                currentState: VHState.TRADE_CANDIDATE_RECEIVED,
                expectedState: VHState.REQUEST_PROPOSAL,
                reason: err.message,
                timeout: 5_000,
                retryCount: null,
                recoveryAction: 'Caller must fix the candidate and re-submit.',
            });
            sm.stop('Invalid TradeCandidate.');
            await this._finishRun(sm, runId);
            this._logRunCompleted({
                runId,
                startedAt: runStartedAt,
                decision: VHDecision.STOPPED,
                reason: err.message,
                roundsCompleted: 0,
                wins: 0,
                losses: 0,
                retryCount: this._proposalRetriesTotal,
                contractId: this._lastContractId,
                roundIndex: this._lastRoundIndex,
            });
            return {
                decision: VHDecision.STOPPED,
                reason: err.message,
                roundsCompleted: 0,
                wins: 0,
                losses: 0,
            };
        }

        sm.transition(VHState.REQUEST_PROPOSAL, 'Candidate validated.');

        let roundIndex = 0;

        try {
            // ── ROUND LOOP ──────────────────────────────────────────
            for (;;) {
                if (this._runAbortRequested) {
                    sm.stop('Abort requested by caller.');
                    await this._finishRun(sm, runId);
                    this._logRunCompleted({
                        runId,
                        startedAt: runStartedAt,
                        decision: VHDecision.STOPPED,
                        reason: 'Abort requested by caller.',
                        roundsCompleted: this._policy.roundsCompleted,
                        wins: this._policy.wins,
                        losses: this._policy.losses,
                        retryCount: this._proposalRetriesTotal,
                        contractId: this._lastContractId,
                        roundIndex: this._lastRoundIndex,
                    });
                    return {
                        decision: VHDecision.STOPPED,
                        reason: 'Abort requested by caller.',
                        roundsCompleted: this._policy.roundsCompleted,
                        wins: this._policy.wins,
                        losses: this._policy.losses,
                    };
                }

                // ── Execute one round ──────────────────────────────
                // The round transitions: REQUEST_PROPOSAL → PROPOSAL_RECEIVED →
                // CREATE_VIRTUAL_CONTRACT → WAIT_FOR_ENTRY → ACTIVE →
                // WAIT_FOR_EXIT → SETTLED → RECORD_TRANSACTION →
                // UPDATE_SHARED_EXIT_HISTORY → POLICY_DECISION.
                const round = await this._runOneRound(sm, runId, roundIndex, candidate);

                if (round.ok) {
                    this._policy.recordOutcome(round.won);
                } else {
                    this._policy.recordOutcome(false, true);
                }

                roundIndex++;

                // ── Evaluate the decision while in POLICY_DECISION ──
                // The state machine is in POLICY_DECISION after _runOneRound.
                // Terminal decisions transition directly from POLICY_DECISION.
                const policyResult = this._policy.evaluate();

                if (policyResult.decision === VHDecision.AUTHORIZED) {
                    sm.transition(VHState.AUTHORIZE_REAL_TRADE, policyResult.reason);
                    await this._finishRun(sm, runId);
                    this._logRunCompleted({
                        runId,
                        startedAt: runStartedAt,
                        decision: VHDecision.AUTHORIZED,
                        reason: policyResult.reason,
                        roundsCompleted: this._policy.roundsCompleted,
                        wins: this._policy.wins,
                        losses: this._policy.losses,
                        retryCount: this._proposalRetriesTotal,
                        contractId: this._lastContractId,
                        roundIndex: this._lastRoundIndex,
                    });
                    return {
                        decision: VHDecision.AUTHORIZED,
                        reason: policyResult.reason,
                        roundsCompleted: this._policy.roundsCompleted,
                        wins: this._policy.wins,
                        losses: this._policy.losses,
                    };
                }
                if (policyResult.decision === VHDecision.REJECTED) {
                    sm.transition(VHState.REJECT, policyResult.reason);
                    await this._finishRun(sm, runId);
                    this._logRunCompleted({
                        runId,
                        startedAt: runStartedAt,
                        decision: VHDecision.REJECTED,
                        reason: policyResult.reason,
                        roundsCompleted: this._policy.roundsCompleted,
                        wins: this._policy.wins,
                        losses: this._policy.losses,
                        retryCount: this._proposalRetriesTotal,
                        contractId: this._lastContractId,
                        roundIndex: this._lastRoundIndex,
                    });
                    return {
                        decision: VHDecision.REJECTED,
                        reason: policyResult.reason,
                        roundsCompleted: this._policy.roundsCompleted,
                        wins: this._policy.wins,
                        losses: this._policy.losses,
                    };
                }
                if (policyResult.decision === VHDecision.STOPPED) {
                    sm.stop(policyResult.reason);
                    await this._finishRun(sm, runId);
                    this._logRunCompleted({
                        runId,
                        startedAt: runStartedAt,
                        decision: VHDecision.STOPPED,
                        reason: policyResult.reason,
                        roundsCompleted: this._policy.roundsCompleted,
                        wins: this._policy.wins,
                        losses: this._policy.losses,
                        retryCount: this._proposalRetriesTotal,
                        contractId: this._lastContractId,
                        roundIndex: this._lastRoundIndex,
                    });
                    return {
                        decision: VHDecision.STOPPED,
                        reason: policyResult.reason,
                        roundsCompleted: this._policy.roundsCompleted,
                        wins: this._policy.wins,
                        losses: this._policy.losses,
                    };
                }

                // CONTINUE — prepare the next round.
                if (sm.state === VHState.POLICY_DECISION) {
                    sm.transition(VHState.REQUEST_PROPOSAL, 'Round complete — preparing next round.');
                }
            }
        } catch (err) {
            // ── Terminal failure ─────────────────────────────────────
            const reason = err instanceof Error ? err.message : String(err);
            this._logger.error('vh.terminal_failure', {
                runId,
                currentState: sm.state,
                expectedState: VHState.STOPPED,
                reason,
                timeout: null,
                retryCount: null,
                recoveryAction: 'Engine stopped — caller must re-submit a new candidate.',
            });
            sm.stop(reason);
            await this._finishRun(sm, runId);
            this._logRunCompleted({
                runId,
                startedAt: runStartedAt,
                decision: VHDecision.STOPPED,
                reason,
                roundsCompleted: this._policy.roundsCompleted,
                wins: this._policy.wins,
                losses: this._policy.losses,
                retryCount: this._proposalRetriesTotal,
                contractId: this._lastContractId,
                roundIndex: this._lastRoundIndex,
            });
            return {
                decision: VHDecision.STOPPED,
                reason,
                roundsCompleted: this._policy.roundsCompleted,
                wins: this._policy.wins,
                losses: this._policy.losses,
            };
        }
    }

    /**
     * Execute a single virtual contract round through the state machine.
     */
    private async _runOneRound(
        sm: VirtualStateMachine,
        runId: string,
        roundIndex: number,
        candidate: TradeCandidate
    ): Promise<RoundResult> {
        // ── REQUEST_PROPOSAL (with retries) ────────────────────────
        let proposal: VHProposal | null = null;
        let proposalRetries = 0;
        let lastProposalFailure: string | null = null;

        while (proposal === null) {
            try {
                const result = await this._proposalAdapter.requestProposal(
                    candidate,
                    this._config.virtualStake,
                    this._config.proposalTimeoutMs
                );

                if (result.ok) {
                    proposal = result.proposal;
                    sm.transition(VHState.PROPOSAL_RECEIVED, 'Proposal received.');
                } else {
                    lastProposalFailure = result.reason;
                    if (!result.retryable || proposalRetries >= this._config.maxProposalRetries) {
                        this._logger.error('vh.proposal_failed', {
                            runId,
                            currentState: VHState.REQUEST_PROPOSAL,
                            expectedState: VHState.PROPOSAL_RECEIVED,
                            reason: result.reason,
                            timeout: this._config.proposalTimeoutMs,
                            retryCount: proposalRetries,
                            recoveryAction: proposalRetries >= this._config.maxProposalRetries
                                ? 'Max retries exhausted — round aborted.'
                                : `Retry proposal (attempt ${proposalRetries + 1}).`,
                        });
                        throw new ProposalError(result.reason, {
                            retryCount: proposalRetries,
                            timeout: this._config.proposalTimeoutMs,
                            timedOut: !result.retryable,
                        });
                    }
                    // Retry within the same proposal state.
                    this._logger.warn('vh.proposal_retry', {
                        runId,
                        currentState: VHState.REQUEST_PROPOSAL,
                        expectedState: VHState.PROPOSAL_RECEIVED,
                        reason: result.reason,
                        timeout: this._config.proposalTimeoutMs,
                        retryCount: proposalRetries,
                        recoveryAction: `Retry proposal (attempt ${proposalRetries + 1}).`,
                    });
                    proposalRetries++;
                    this._proposalRetriesTotal++;
                    await this._sleep(this._getRetryDelayMs(proposalRetries));
                }
            } catch (err) {
                if (err instanceof VirtualHookError && err.name === 'ProposalError') {
                    throw err;
                }
                // Unexpected adapter error — treat as retryable.
                lastProposalFailure = err instanceof Error ? err.message : String(err);
                if (proposalRetries >= this._config.maxProposalRetries) {
                    this._logger.error('vh.proposal_failed', {
                        runId,
                        currentState: VHState.REQUEST_PROPOSAL,
                        expectedState: VHState.PROPOSAL_RECEIVED,
                        reason: lastProposalFailure,
                        timeout: this._config.proposalTimeoutMs,
                        retryCount: proposalRetries,
                        recoveryAction: 'Max retries exhausted — round aborted as failure.',
                    });
                    throw new ProposalError(lastProposalFailure, {
                        retryCount: proposalRetries,
                        timeout: this._config.proposalTimeoutMs,
                    });
                }
                proposalRetries++;
                this._proposalRetriesTotal++;
                await this._sleep(this._getRetryDelayMs(proposalRetries));
            }
        }

        // ── CREATE_VIRTUAL_CONTRACT ───────────────────────────────
        sm.transition(VHState.CREATE_VIRTUAL_CONTRACT, 'Proposal received.');

        const contract = VirtualContractFactory.create(
            runId,
            roundIndex,
            candidate,
            proposal.id,
            proposal.askPrice,
            this._config.virtualStake
        );

        sm.transition(VHState.WAIT_FOR_ENTRY, 'Virtual contract created.');

        // ── WAIT_FOR_ENTRY ──────────────────────────────────────────
        let entryTick: VHTick | null = null;
        try {
            entryTick = await this._waitForFirstTick(candidate.symbol);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this._logger.warn('vh.entry_timeout', {
                runId,
                currentState: VHState.WAIT_FOR_ENTRY,
                expectedState: VHState.SETTLED,
                reason,
                timeout: DEFAULT_ENTRY_TICK_TIMEOUT_MS,
                retryCount: null,
                recoveryAction: 'No entry tick — round treated as a failure.',
            });

            // The round ended without a settlement tick. Advance the state
            // machine through SETTLED → RECORD_TRANSACTION →
            // UPDATE_SHARED_EXIT_HISTORY → POLICY_DECISION so the run loop
            // always lands in POLICY_DECISION (see the _runOneRound contract
            // in start()). Without this, a RETRY decision on the failure would
            // attempt an illegal transition out of WAIT_FOR_ENTRY on the next
            // round and abort the run with IllegalStateTransitionError.
            sm.transition(VHState.SETTLED, 'Entry timeout — no settlement tick.');
            sm.transition(VHState.RECORD_TRANSACTION, 'Entry timeout — no transaction to record (failure counted).');
            sm.transition(VHState.UPDATE_SHARED_EXIT_HISTORY, 'Entry timeout — no exit digit to record.');
            sm.transition(VHState.POLICY_DECISION, 'Entry timeout — round treated as failure.');

            return {
                contract,
                ok: false,
                won: false,
                settledAt: Date.now(),
            };
        }

        // Entry tick captured.
        let activeContract = VirtualContractFactory.recordEntry(contract, entryTick.quote);

        sm.transition(VHState.ACTIVE, `Entry tick observed: ${entryTick.quote}`);

        // ── WAIT_FOR_EXIT / ACTIVE ─────────────────────────────────
        let exitTick: VHTick | null;
        try {
            exitTick = await this._waitForExitTick(candidate, entryTick);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this._logger.warn('vh.exit_timeout', {
                runId,
                currentState: VHState.ACTIVE,
                expectedState: VHState.SETTLED,
                reason,
                timeout: this._config.settlementTimeoutMs,
                retryCount: null,
                recoveryAction: 'Using last observed tick as fallback exit digit.',
            });
            // Fallback: use the entry tick digit (last known).
            exitTick = entryTick;
        }

        sm.transition(VHState.WAIT_FOR_EXIT, 'Settlement tick observed.');

        // ── SETTLED (canonical settlement evaluation) ──────────────
        let won: boolean;
        if (isDigitContract(candidate.contractType)) {
            const settlement = settleDigitContract(candidate, exitTick.digit);
            won = settlement.won;
        } else {
            // Non-digit contracts are not yet supported for settlement
            // evaluation. Treat as a loss and log.
            this._logger.warn('vh.unsupported_contract_type', {
                runId,
                currentState: VHState.WAIT_FOR_EXIT,
                expectedState: VHState.SETTLED,
                reason: `Contract type '${candidate.contractType}' is not digit-based and cannot be settled by the canonical engine.`,
                timeout: null,
                retryCount: null,
                recoveryAction: 'Treated as a loss with a warning.',
            });
            won = false;
        }

        const settledContract = VirtualContractFactory.settle(
            activeContract,
            {
                won,
                source: 'api',
                rawContract: null,
                settledAt: Date.now(),
            },
            exitTick.quote
        );

        sm.transition(VHState.SETTLED, `Settlement determined: ${won ? 'WON' : 'LOST'}`);

        // ── RECORD_TRANSACTION → UPDATE_SHARED_EXIT_HISTORY ────────
        sm.transition(VHState.RECORD_TRANSACTION, 'Settlement complete.');

        let recordWarnings: string[] = [];
        try {
            const recordResult = await this._pipeline.process(settledContract);
            recordWarnings = recordResult.warnings;
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this._logger.error('vh.record_failed', {
                runId,
                currentState: VHState.RECORD_TRANSACTION,
                expectedState: VHState.UPDATE_SHARED_EXIT_HISTORY,
                reason,
                timeout: 10_000,
                retryCount: null,
                recoveryAction: 'Recording failure is non-fatal — continuing with policy evaluation.',
            });
        }

        sm.transition(VHState.UPDATE_SHARED_EXIT_HISTORY, 'Transaction recorded.');

        // Track the last settled contract reference for run-completion logs.
        this._lastContractId = settledContract.contractId;
        this._lastRoundIndex = settledContract.roundIndex;

        this._logger.info('vh.round_completed', {
            runId,
            currentState: VHState.UPDATE_SHARED_EXIT_HISTORY,
            expectedState: VHState.POLICY_DECISION,
            reason: `Round ${roundIndex} completed (won=${won}).`,
            timeout: null,
            retryCount: null,
            recoveryAction: null,
            contractId: settledContract.contractId,
            exitDigit: exitTick.digit,
            warnings: recordWarnings,
        });

        sm.transition(VHState.POLICY_DECISION, 'All recording steps complete.');

        return {
            contract: settledContract,
            ok: true,
            won,
            settledAt: settledContract.settledAt ?? Date.now(),
        };
    }

    /**
     * Wait for the first market tick for the given symbol.
     */
    private async _waitForFirstTick(symbol: string): Promise<VHTick> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new SettlementTimeoutError('entry', DEFAULT_ENTRY_TICK_TIMEOUT_MS));
            }, DEFAULT_ENTRY_TICK_TIMEOUT_MS);

            const onTick = (tick: VHTick) => {
                cleanup();
                resolve(tick);
            };

            const cleanup = () => {
                clearTimeout(timer);
            };

            this._tickObserver.start(symbol, onTick).catch(err => {
                cleanup();
                reject(err);
            });
        });
    }

    /**
     * Wait for the exit tick based on the candidate's duration.
     *
     * For 't' (tick) duration: waits for the specified number of ticks
     * and returns the last observed. For other units: waits the
     * time duration and returns the last observed tick.
     */
    private async _waitForExitTick(candidate: TradeCandidate, entryTick: VHTick): Promise<VHTick> {
        let lastTick = entryTick;

        const onTick = (tick: VHTick) => {
            lastTick = tick;
        };

        await this._tickObserver.start(candidate.symbol, onTick);

        if (candidate.durationUnit === 't') {
            const startTime = Date.now();
            // Wait for the tick-duration budget OR until time budget is exhausted.
            const tickBudgetMs = Math.min(
                this._config.settlementTimeoutMs,
                this._durationToMs(candidate.duration, 't')
            );
            while (Date.now() - startTime < tickBudgetMs) {
                if (this._runAbortRequested) break;
                await this._sleep(100);
            }
            return lastTick;
        }

        const waitMs = Math.min(
            this._config.settlementTimeoutMs,
            Math.max(1, this._durationToMs(candidate.duration, candidate.durationUnit))
        );
        await this._sleep(waitMs);
        return lastTick;
    }

    /**
     * Convert a candidate duration to milliseconds.
     */
    private _durationToMs(duration: number, unit: 't' | 's' | 'm' | 'h' | 'd'): number {
        const n = Math.max(1, duration || 1);
        switch (unit) {
            case 't': return n * 1_000;
            case 's': return n * 1_000;
            case 'm': return n * 60_000;
            case 'h': return n * 3_600_000;
            case 'd': return n * 86_400_000;
            default: return n * 60_000;
        }
    }

    /**
     * Compute a backoff delay for proposal retries (exponential).
     */
    private _getRetryDelayMs(retryCount: number): number {
        return Math.min(2_000 * 2 ** Math.max(0, retryCount - 1), 5_000);
    }

    /**
     * Promise-based sleep.
     */
    private _sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Emit a structured run-completion log for every terminal decision.
     *
     * Provides full observability:
     *   decision, reason, rounds/wins/losses, duration, retry count,
     *   and the last settled contract/round reference.
     */
    private _logRunCompleted(params: {
        runId: string;
        startedAt: number;
        decision: VHDecision;
        reason: string;
        roundsCompleted: number;
        wins: number;
        losses: number;
        retryCount: number;
        contractId: string | null;
        roundIndex: number | null;
    }): void {
        this._logger.info('vh.run_completed', {
            runId: params.runId,
            currentState: VHState.IDLE,
            expectedState: VHState.IDLE,
            reason: params.reason,
            timeout: null,
            retryCount: params.retryCount,
            recoveryAction: null,
            decision: params.decision,
            roundsCompleted: params.roundsCompleted,
            wins: params.wins,
            losses: params.losses,
            durationMs: Date.now() - params.startedAt,
            contractId: params.contractId,
            roundIndex: params.roundIndex,
        });
    }

    /**
     * Dispose the engine — release adapters, subscriptions, timers, and
     * pending run state. Safe to call at any point (idle or mid-run).
     *
     * After dispose():
     *   • start() fails fast with VirtualHookError.
     *   • configure() is rejected.
     *   • The engine cannot be reused — create a new instance.
     */
    async dispose(): Promise<void> {
        // Abort any in-progress run so its awaits short-circuit.
        this._runAbortRequested = true;

        try {
            await this._tickObserver.stop();
        } catch (err) {
            this._logger.warn('vh.dispose_observer_stop_failed', {
                runId: this._currentRunId ?? 'none',
                currentState: VHState.IDLE,
                expectedState: VHState.IDLE,
                reason: err instanceof Error ? err.message : String(err),
                timeout: null,
                retryCount: null,
                recoveryAction: 'Ignored — observer stop is best-effort.',
            });
        }

        try {
            this._proposalAdapter.abort();
        } catch (err) {
            this._logger.warn('vh.dispose_adapter_abort_failed', {
                runId: this._currentRunId ?? 'none',
                currentState: VHState.IDLE,
                expectedState: VHState.IDLE,
                reason: err instanceof Error ? err.message : String(err),
                timeout: null,
                retryCount: null,
                recoveryAction: 'Ignored — adapter abort is best-effort.',
            });
        }

        this._disposed = true;
        this._busy = false;
        this._currentRunId = null;
        this._runAbortRequested = false;
        this._lastContractId = null;
        this._lastRoundIndex = null;

        this._logger.info('vh.disposed', {
            runId: 'none',
            currentState: VHState.IDLE,
            expectedState: VHState.IDLE,
            reason: 'Engine disposed.',
            timeout: null,
            retryCount: null,
            recoveryAction: null,
        });
    }

    /**
     * Clean up the run state (busy flag, observer stop, state reset).
     */
    private async _finishRun(sm: VirtualStateMachine, runId: string): Promise<void> {
        this._busy = false;
        this._currentRunId = null;
        sm.reset();
        try {
            await this._tickObserver.stop();
        } catch (err) {
            this._logger.warn('vh.observer_stop_failed', {
                runId,
                currentState: VHState.IDLE,
                expectedState: VHState.IDLE,
                reason: err instanceof Error ? err.message : String(err),
                timeout: null,
                retryCount: null,
                recoveryAction: 'Ignored — observer stop is best-effort.',
            });
        }
    }
}