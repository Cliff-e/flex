// =============================================================
// errors — VH-specific error types
//
// Every failure in the Virtual Hook subsystem raises one of these
// typed errors. Each error carries the context required by the
// state machine and VHLogger to produce structured failure logs.
// =============================================================

/**
 * Base class for all Virtual Hook errors.
 * Carries structured context for observability.
 */
export class VirtualHookError extends Error {
    /** The state the engine was in when the error occurred. */
    readonly currentState: string;

    /** The state the engine expected to transition to. */
    readonly expectedState: string;

    /** The configured timeout (ms) for the operation that failed, or null. */
    readonly timeout: number | null;

    /** The retry count at the time of failure, or null. */
    readonly retryCount: number | null;

    /** The recovery action that will be attempted. */
    readonly recoveryAction: string;

    constructor(
        message: string,
        options: {
            currentState: string;
            expectedState: string;
            timeout?: number | null;
            retryCount?: number | null;
            recoveryAction?: string;
            cause?: unknown;
        }
    ) {
        super(message);
        if (options.cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = options.cause;
        }
        this.name = 'VirtualHookError';
        this.currentState = options.currentState;
        this.expectedState = options.expectedState;
        this.timeout = options.timeout ?? null;
        this.retryCount = options.retryCount ?? null;
        this.recoveryAction = options.recoveryAction ?? 'None';
    }
}

/**
 * Raised when a TradeCandidate fails structural validation.
 * This is non-recoverable — the caller submitted malformed input.
 */
export class InvalidTradeCandidateError extends VirtualHookError {
    constructor(message: string, cause?: unknown) {
        super(message, {
            currentState: 'TRADE_CANDIDATE_RECEIVED',
            expectedState: 'REQUEST_PROPOSAL',
            recoveryAction: 'Caller must fix the candidate and re-submit.',
            cause,
        });
        this.name = 'InvalidTradeCandidateError';
    }
}

/**
 * Raised when the proposal adapter fails or times out.
 * This is recoverable through retry.
 */
export class ProposalError extends VirtualHookError {
    /** Whether this was a timeout or an explicit API error. */
    readonly timedOut: boolean;

    constructor(message: string, options: { timeout?: number; retryCount?: number; timedOut?: boolean; cause?: unknown } = {}) {
        super(message, {
            currentState: 'REQUEST_PROPOSAL',
            expectedState: 'PROPOSAL_RECEIVED',
            timeout: options.timeout ?? null,
            retryCount: options.retryCount ?? null,
            recoveryAction: `Retry proposal request (attempt ${(options.retryCount ?? 0) + 1}).`,
            cause: options.cause,
        });
        this.name = 'ProposalError';
        this.timedOut = options.timedOut ?? false;
    }
}

/**
 * Raised when the virtual contract fails to settle within the
 * configured timeout. The contract must be treated as timed out.
 */
export class SettlementTimeoutError extends VirtualHookError {
    /** The virtual contract id that timed out. */
    readonly contractId: string;

    constructor(contractId: string, timeout: number) {
        super(`Virtual contract ${contractId} did not settle within ${timeout}ms.`, {
            currentState: 'ACTIVE',
            expectedState: 'SETTLED',
            timeout,
            recoveryAction: 'Mark contract as TIMED_OUT and treat as a loss.',
        });
        this.name = 'SettlementTimeoutError';
        this.contractId = contractId;
    }
}

/**
 * Raised when a VH round is aborted/disposed while waiting for an
 * exit tick and NO genuine exit tick arrived before the abort.
 *
 * This error makes it structurally impossible for the round to settle
 * using the ENTRY tick as an exit tick merely because the engine was
 * disposed mid-round (interpreter stop, session teardown).
 *
 * The round terminates WITHOUT settlement — no transaction is recorded,
 * no exit digit is appended, and the caller receives STOPPED.
 */
export class VHAbortError extends VirtualHookError {
    constructor(message: string) {
        super(message, {
            currentState: 'ACTIVE',
            expectedState: 'STOPPED',
            recoveryAction: 'Round aborted before a genuine exit tick arrived — no settlement recorded.',
        });
        this.name = 'VHAbortError';
    }
}

/**
 * Raised when the engine is already processing a signal and a second
 * start() call is attempted. This is a concurrency guard violation.
 */
export class VirtualHookBusyError extends VirtualHookError {
    constructor() {
        super('VirtualHookEngine is already processing a signal.', {
            currentState: 'ACTIVE_RUN',
            expectedState: 'IDLE',
            recoveryAction: 'Caller must wait for the in-progress run to complete.',
        });
        this.name = 'VirtualHookBusyError';
    }
}

/**
 * Raised when a state machine encounters an illegal transition.
 * Indicates a programming error — the state graph must never
 * allow this transition path.
 */
export class IllegalStateTransitionError extends VirtualHookError {
    constructor(fromState: string, toState: string, reason: string) {
        super(`Illegal state transition: ${fromState} → ${toState}. Reason: ${reason}`, {
            currentState: fromState,
            expectedState: toState,
            recoveryAction: 'Stop the engine — this indicates a state machine programming error.',
        });
        this.name = 'IllegalStateTransitionError';
    }
}