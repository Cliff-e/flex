// =============================================================
// VirtualPolicy — Threshold evaluation & authorization rules
//
// Decides whether accumulated virtual contract outcomes justify
// authorizing, retrying, or stopping a VH authorization session.
// This component owns NO execution logic — it only evaluates
// counters against configured thresholds.
// =============================================================

import type { VHConfig } from './VHConfig';
import { VHDecision } from './VHDecision';

/**
 * Result of a policy evaluation.
 */
export interface PolicyResult {
    /** The decision the engine should act on. */
    decision: VHDecision;

    /** Number of completed rounds so far. */
    roundsCompleted: number;

    /** Number of wins so far. */
    wins: number;

    /** Number of losses so far. */
    losses: number;

    /** Consecutive wins in the current outcome streak. */
    consecutiveVirtualWins: number;

    /** Consecutive losses in the current outcome streak. */
    consecutiveVirtualLosses: number;

    /** Number of successfully settled virtual contracts in this session. */
    virtualInstanceCount: number;

    /**
     * Reason for the decision.
     * Examples: 'WIN_STREAK_REACHED', 'LOSS_STREAK_REACHED',
     * 'MAX_STEPS_REACHED', 'MAX_CONSECUTIVE_FAILURES'.
     */
    reason: string;
}

/**
 * Tracks the accumulated outcome of virtual contracts for one VH session.
 */
export class VirtualPolicy {
    private _config: VHConfig;

    private _roundsCompleted = 0;
    private _wins = 0;
    private _losses = 0;
    private _consecutiveVirtualWins = 0;
    private _consecutiveVirtualLosses = 0;
    private _virtualInstanceCount = 0;
    private _consecutiveFailures = 0;

    constructor(config: VHConfig) {
        this._config = config;
    }

    /**
     * Reset all session counters. Called at the start of each run.
     */
    reset(): void {
        this._roundsCompleted = 0;
        this._wins = 0;
        this._losses = 0;
        this._consecutiveVirtualWins = 0;
        this._consecutiveVirtualLosses = 0;
        this._virtualInstanceCount = 0;
        this._consecutiveFailures = 0;
    }

    /**
     * Record the outcome of one completed virtual round.
     *
     * @param won        - Whether the virtual contract won.
     * @param isFailure  - true if the round failed due to a transient
     *                     error (API, timeout) and should not count
     *                     toward wins/losses but DOES count toward the
     *                     consecutive-failure budget.
     */
    recordOutcome(won: boolean, isFailure = false): void {
        if (isFailure) {
            this._consecutiveFailures++;
            return;
        }
        this._consecutiveFailures = 0;
        this._roundsCompleted++;
        this._virtualInstanceCount++;
        if (won) {
            this._wins++;
            this._consecutiveVirtualWins++;
            this._consecutiveVirtualLosses = 0;
        } else {
            this._losses++;
            this._consecutiveVirtualLosses++;
            this._consecutiveVirtualWins = 0;
        }
    }

    /**
     * Evaluate the current counters and return a decision.
     */
    evaluate(): PolicyResult {
        if (
            this._config.winThresholdEnabled &&
            this._config.winThreshold > 0 &&
            this._consecutiveVirtualWins >= this._config.winThreshold
        ) {
            return this._result(VHDecision.AUTHORIZED, 'WIN_STREAK_REACHED');
        }

        if (
            this._config.lossThresholdEnabled &&
            this._config.lossThreshold > 0 &&
            this._consecutiveVirtualLosses >= this._config.lossThreshold
        ) {
            return this._result(VHDecision.AUTHORIZED, 'LOSS_STREAK_REACHED');
        }

        if (
            this._config.maxStepsEnabled &&
            this._config.maxSteps > 0 &&
            this._virtualInstanceCount >= this._config.maxSteps
        ) {
            return this._result(VHDecision.AUTHORIZED, 'MAX_STEPS_REACHED');
        }

        // Ran out of retry budget due to transient failures.
        if (this._consecutiveFailures >= this._config.maxConsecutiveFailures) {
            return this._result(VHDecision.STOPPED, 'MAX_CONSECUTIVE_FAILURES');
        }

        // Otherwise continue observing.
        return this._result(VHDecision.RETRY, 'CONTINUE');
    }

    private _result(decision: VHDecision, reason: string): PolicyResult {
        return {
            decision,
            roundsCompleted: this._roundsCompleted,
            wins: this._wins,
            losses: this._losses,
            consecutiveVirtualWins: this._consecutiveVirtualWins,
            consecutiveVirtualLosses: this._consecutiveVirtualLosses,
            virtualInstanceCount: this._virtualInstanceCount,
            reason,
        };
    }

    // ── Query accessors (for observability) ─────────────────────

    get roundsCompleted(): number {
        return this._roundsCompleted;
    }

    get wins(): number {
        return this._wins;
    }

    get losses(): number {
        return this._losses;
    }

    get consecutiveVirtualWins(): number {
        return this._consecutiveVirtualWins;
    }

    get consecutiveVirtualLosses(): number {
        return this._consecutiveVirtualLosses;
    }

    get virtualInstanceCount(): number {
        return this._virtualInstanceCount;
    }

    get consecutiveFailures(): number {
        return this._consecutiveFailures;
    }

    get config(): VHConfig {
        return { ...this._config };
    }
}