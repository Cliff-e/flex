// =============================================================
// VirtualStateMachine — Explicit lifecycle state machine
//
// Every state has documented entry conditions, exit conditions,
// timeout, failure behaviour, and retry behaviour.
//
// This component owns NO business logic — it only manages legal
// transitions and reports them to the logger.
// =============================================================

import type { VHLogger } from './VHLogger';
import { IllegalStateTransitionError } from './errors';

/**
 * All states of the Virtual Hook lifecycle.
 */
export enum VHState {
    IDLE = 'IDLE',
    TRADE_CANDIDATE_RECEIVED = 'TRADE_CANDIDATE_RECEIVED',
    REQUEST_PROPOSAL = 'REQUEST_PROPOSAL',
    PROPOSAL_RECEIVED = 'PROPOSAL_RECEIVED',
    CREATE_VIRTUAL_CONTRACT = 'CREATE_VIRTUAL_CONTRACT',
    WAIT_FOR_ENTRY = 'WAIT_FOR_ENTRY',
    ACTIVE = 'ACTIVE',
    WAIT_FOR_EXIT = 'WAIT_FOR_EXIT',
    TECHNICAL_FAILURE = 'TECHNICAL_FAILURE',
    SETTLED = 'SETTLED',
    RECORD_TRANSACTION = 'RECORD_TRANSACTION',
    UPDATE_SHARED_EXIT_HISTORY = 'UPDATE_SHARED_EXIT_HISTORY',
    POLICY_DECISION = 'POLICY_DECISION',
    AUTHORIZE_REAL_TRADE = 'AUTHORIZE_REAL_TRADE',
    REJECT = 'REJECT',
    STOPPED = 'STOPPED',
}

/**
 * Metadata for each state: entry conditions, timeout, and
 * failure/recovery description. Used for observability.
 */
export interface VHStateInfo {
    /** A human-readable entry-condition description. */
    entryConditions: string;

    /** A human-readable exit-condition description. */
    exitConditions: string;

    /** Timeout (ms), or null when no timeout applies. */
    timeoutMs: number | null;

    /** Failure behavior. */
    failureBehavior: string;

    /** Retry behavior. */
    retryBehavior: string;
}

/**
 * Map of state metadata used for documentation and diagnostics.
 */
export const VH_STATE_INFO: Record<VHState, VHStateInfo> = {
    [VHState.IDLE]: {
        entryConditions: 'Engine constructed / previous run finished.',
        exitConditions: 'start() called with a valid TradeCandidate.',
        timeoutMs: null,
        failureBehavior: 'No failure possible.',
        retryBehavior: 'Not applicable.',
    },
    [VHState.TRADE_CANDIDATE_RECEIVED]: {
        entryConditions: 'start() received a candidate.',
        exitConditions: 'Candidate passes structural validation.',
        timeoutMs: 5_000,
        failureBehavior: 'Invalid candidate: log and move to STOPPED.',
        retryBehavior: 'No retry — malformed input must be fixed by the caller.',
    },
    [VHState.REQUEST_PROPOSAL]: {
        entryConditions: 'Candidate validated.',
        exitConditions: 'Proposal adapter returns a valid proposal.',
        timeoutMs: 15_000,
        failureBehavior: 'Proposal adapter error or timeout: log; increment retry counter.',
        retryBehavior: 'Up to maxProposalRetries, then STOPPED.',
    },
    [VHState.PROPOSAL_RECEIVED]: {
        entryConditions: 'Proposal adapter returned a proposal.',
        exitConditions: 'Virtual contract constructed.',
        timeoutMs: null,
        failureBehavior: 'Contract construction failure: log and STOPPED.',
        retryBehavior: 'No retry — internal error.',
    },
    [VHState.CREATE_VIRTUAL_CONTRACT]: {
        entryConditions: 'Proposal ID and ask price available.',
        exitConditions: 'VirtualContract instance created.',
        timeoutMs: 1_000,
        failureBehavior: 'Construction error: log and STOPPED.',
        retryBehavior: 'No retry — internal error.',
    },
    [VHState.WAIT_FOR_ENTRY]: {
        entryConditions: 'Virtual contract created.',
        exitConditions: 'First tick with a valid digit observed.',
        timeoutMs: 30_000,
        failureBehavior: 'No entry tick within timeout: record a technical failure without settlement.',
        retryBehavior: 'Retry until the technical-failure safety limit is reached.',
    },
    [VHState.ACTIVE]: {
        entryConditions: 'Entry digit captured; contract running.',
        exitConditions: 'Settlement event received or duration elapsed.',
        timeoutMs: 30_000,
        failureBehavior: 'Settlement timeout: record a technical failure without settlement.',
        retryBehavior: 'Retry until the technical-failure safety limit is reached.',
    },
    [VHState.WAIT_FOR_EXIT]: {
        entryConditions: 'Settlement event received.',
        exitConditions: 'Exit digit extracted.',
        timeoutMs: 5_000,
        failureBehavior: 'Exit digit unavailable: record a technical failure without settlement.',
        retryBehavior: 'Retry until the technical-failure safety limit is reached.',
    },
    [VHState.TECHNICAL_FAILURE]: {
        entryConditions: 'A required live tick or settlement event was unavailable.',
        exitConditions: 'Failure recorded for policy evaluation.',
        timeoutMs: null,
        failureBehavior: 'No transaction or outcome is recorded.',
        retryBehavior: 'Policy may retry or stop on consecutive failures.',
    },
    [VHState.SETTLED]: {
        entryConditions: 'Win/loss determined.',
        exitConditions: 'Settlement recorded to the transaction pipeline.',
        timeoutMs: 5_000,
        failureBehavior: 'Recording error: log and continue (non-fatal).',
        retryBehavior: 'No retry — non-fatal.',
    },
    [VHState.RECORD_TRANSACTION]: {
        entryConditions: 'Settlement complete.',
        exitConditions: 'Transaction + Summary + Journal updated.',
        timeoutMs: 10_000,
        failureBehavior: 'Recording error: log, retry once, then continue.',
        retryBehavior: '1 retry.',
    },
    [VHState.UPDATE_SHARED_EXIT_HISTORY]: {
        entryConditions: 'Transaction recorded.',
        exitConditions: 'Exit digit appended to shared history (if digit contract).',
        timeoutMs: 2_000,
        failureBehavior: 'Append error: log and continue (non-fatal).',
        retryBehavior: 'No retry — non-fatal.',
    },
    [VHState.POLICY_DECISION]: {
        entryConditions: 'All outcomes recorded for this round.',
        exitConditions: 'Policy evaluates: AUTHORIZED / REJECTED / RETRY / STOPPED.',
        timeoutMs: 1_000,
        failureBehavior: 'Policy evaluation error: default to STOPPED.',
        retryBehavior: 'No retry — default to STOPPED.',
    },
    [VHState.AUTHORIZE_REAL_TRADE]: {
        entryConditions: 'Policy returned AUTHORIZED.',
        exitConditions: 'VHDecision.AUTHORIZED returned to the caller.',
        timeoutMs: null,
        failureBehavior: 'No failure possible.',
        retryBehavior: 'Not applicable.',
    },
    [VHState.REJECT]: {
        entryConditions: 'Policy returned REJECTED or max rounds exhausted.',
        exitConditions: 'VHDecision.REJECTED returned to the caller.',
        timeoutMs: null,
        failureBehavior: 'No failure possible.',
        retryBehavior: 'Not applicable.',
    },
    [VHState.STOPPED]: {
        entryConditions: 'Irrecoverable error or explicit abort.',
        exitConditions: 'VHDecision.STOPPED returned to the caller.',
        timeoutMs: null,
        failureBehavior: 'No failure possible — terminal.',
        retryBehavior: 'Not applicable.',
    },
};

/**
 * Legal transition map: from-state → set of allowed to-states.
 */
const TRANSITIONS: Record<VHState, ReadonlySet<VHState>> = {
    [VHState.IDLE]: new Set([VHState.TRADE_CANDIDATE_RECEIVED]),
    [VHState.TRADE_CANDIDATE_RECEIVED]: new Set([VHState.REQUEST_PROPOSAL, VHState.STOPPED]),
    [VHState.REQUEST_PROPOSAL]: new Set([VHState.PROPOSAL_RECEIVED, VHState.REQUEST_PROPOSAL, VHState.STOPPED]),
    [VHState.PROPOSAL_RECEIVED]: new Set([VHState.CREATE_VIRTUAL_CONTRACT, VHState.REQUEST_PROPOSAL]),
    [VHState.CREATE_VIRTUAL_CONTRACT]: new Set([VHState.WAIT_FOR_ENTRY, VHState.STOPPED]),
    [VHState.WAIT_FOR_ENTRY]: new Set([VHState.ACTIVE, VHState.TECHNICAL_FAILURE]),
    [VHState.ACTIVE]: new Set([VHState.WAIT_FOR_EXIT, VHState.TECHNICAL_FAILURE]),
    [VHState.WAIT_FOR_EXIT]: new Set([VHState.SETTLED]),
    [VHState.TECHNICAL_FAILURE]: new Set([VHState.POLICY_DECISION]),
    [VHState.SETTLED]: new Set([VHState.RECORD_TRANSACTION]),
    [VHState.RECORD_TRANSACTION]: new Set([VHState.UPDATE_SHARED_EXIT_HISTORY, VHState.POLICY_DECISION]),
    [VHState.UPDATE_SHARED_EXIT_HISTORY]: new Set([VHState.POLICY_DECISION]),
    [VHState.POLICY_DECISION]: new Set([
        VHState.AUTHORIZE_REAL_TRADE,
        VHState.REJECT,
        VHState.STOPPED,
        VHState.REQUEST_PROPOSAL,
    ]),
    [VHState.AUTHORIZE_REAL_TRADE]: new Set([]),
    [VHState.REJECT]: new Set([]),
    [VHState.STOPPED]: new Set([]),
};

/**
 * Explicit state machine for the Virtual Hook lifecycle.
 *
 * Responsibilities:
 *   - Validate every transition against the legal transition map.
 *   - Enforce "no silent transitions" by logging each one.
 *   - Report the current state to callers.
 */
export class VirtualStateMachine {
    private _current: VHState = VHState.IDLE;
    private readonly _logger: VHLogger;
    private readonly _runId: string;

    constructor(logger: VHLogger, runId: string) {
        this._logger = logger;
        this._runId = runId;
    }

    /**
     * The current state.
     */
    get state(): VHState {
        return this._current;
    }

    /**
     * Attempt a transition to the given state.
     *
     * @throws IllegalStateTransitionError when the transition is not legal.
     */
    transition(to: VHState, reason: string): void {
        const allowed = TRANSITIONS[this._current];
        if (!allowed.has(to)) {
            throw new IllegalStateTransitionError(this._current, to, reason);
        }

        const from = this._current;
        this._current = to;

        this._logger.info('vh.state_transition', {
            runId: this._runId,
            currentState: from,
            expectedState: to,
            reason,
            timeout: null,
            retryCount: null,
            recoveryAction: null,
        });
    }

    /**
     * Transition back to REQUEST_PROPOSAL for the next round.
     * Only legal from POLICY_DECISION.
     */
    nextRound(reason: string): void {
        this.transition(VHState.REQUEST_PROPOSAL, reason);
    }

    /**
     * Force the machine into STOPPED (terminal state).
     * Allowed from any state.
     */
    stop(reason: string): void {
        if (this._current === VHState.STOPPED) return;
        const from = this._current;
        this._current = VHState.STOPPED;
        this._logger.warn('vh.state_transition', {
            runId: this._runId,
            currentState: from,
            expectedState: VHState.STOPPED,
            reason,
            timeout: null,
            retryCount: null,
            recoveryAction: null,
        });
    }

    /**
     * Reset the machine to IDLE (used between runs).
     */
    reset(): void {
        const from = this._current;
        this._current = VHState.IDLE;
        if (from !== VHState.IDLE) {
            this._logger.info('vh.state_transition', {
                runId: this._runId,
                currentState: from,
                expectedState: VHState.IDLE,
                reason: 'Engine reset between runs.',
                timeout: null,
                retryCount: null,
                recoveryAction: null,
            });
        }
    }

    /**
     * Convenience getter for observability.
     */
    getStateInfo(state: VHState = this._current): VHStateInfo {
        return VH_STATE_INFO[state];
    }
}