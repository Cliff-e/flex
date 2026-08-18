// =============================================================
// VirtualPolicy — Threshold evaluation & authorization rules
//
// Decides whether accumulated virtual round outcomes justify
// authorizing, rejecting, retrying, or stopping a signal.
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

    /**
     * Reason for the decision.
     * Examples: 'MIN_WINS_REACHED', 'MAX_STEPS_REACHED',
     * 'MAX_CONSECUTIVE_FAILURES', 'CANDIDATE_MALFORMED'.
     */
    reason: string;
}

/**
 * Tracks the accumulated outcome of virtual rounds for one signal.
 */
export class VirtualPolicy {
    private _config: VHConfig;

    private _roundsCompleted = 0;
    private _wins = 0;
    private _losses = 0;
    private _consecutiveFailures = 0;
    private _roundsLimitExhausted = false;

    constructor(config: VHConfig) {
        this._config = config;
    }

    /**
     * Reset all per-signal counters. Called at the start of each run.
     */
    reset(): void {
        this._roundsCompleted = 0;
        this._wins = 0;
        this._losses = 0;
        this._consecutiveFailures = 0;
        this._roundsLimitExhausted = false;
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
        if (won) this._wins++;
        else this._losses++;
    }

    /**
     * Evaluate the current counters and return a decision.
     */
    evaluate(): PolicyResult {
        // Exhausted the round budget without enough wins.
        this._roundsLimitExhausted = this._roundsCompleted >= this._config.maxSteps;
        if (this._roundsLimitExhausted) {
            if (this._wins >= this._config.minWins) {
                return {
                    decision: VHDecision.AUTHORIZED,
                    roundsCompleted: this._roundsCompleted,
                    wins: this._wins,
                    losses: this._losses,
                    reason: 'MIN_WINS_REACHED',
                };
            }
            return {
                decision: VHDecision.REJECTED,
                roundsCompleted: this._roundsCompleted,
                wins: this._wins,
                losses: this._losses,
                reason: 'MAX_STEPS_REACHED',
            };
        }

        // Won the required number of rounds early.
        if (this._wins >= this._config.minWins) {
            return {
                decision: VHDecision.AUTHORIZED,
                roundsCompleted: this._roundsCompleted,
                wins: this._wins,
                losses: this._losses,
                reason: 'MIN_WINS_REACHED_EARLY',
            };
        }

        // Ran out of retry budget due to transient failures.
        if (this._consecutiveFailures >= this._config.maxConsecutiveFailures) {
            return {
                decision: VHDecision.STOPPED,
                roundsCompleted: this._roundsCompleted,
                wins: this._wins,
                losses: this._losses,
                reason: 'MAX_CONSECUTIVE_FAILURES',
            };
        }

        // Otherwise continue observing.
        return {
            decision: VHDecision.RETRY,
            roundsCompleted: this._roundsCompleted,
            wins: this._wins,
            losses: this._losses,
            reason: 'CONTINUE',
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

    get consecutiveFailures(): number {
        return this._consecutiveFailures;
    }

    get config(): VHConfig {
        return { ...this._config };
    }
}