// =============================================================
// VHLogger — Structured observability
//
// Every state transition and every failure is logged with
// structured context so the Virtual Hook subsystem can be audited.
//
//     No silent failures.
// =============================================================

/**
 * Context attached to every structured log entry.
 */
export interface VHLogContext {
    /** Unique run id (one TradeCandidate evaluation). */
    runId: string;

    /** The state the engine was in. */
    currentState: string;

    /** The state the engine expected to transition to. */
    expectedState?: string;

    /** Reason for the event. */
    reason: string;

    /** Configured timeout (ms) that applied, if any. */
    timeout?: number | null;

    /** Retry count at the time of the event, if any. */
    retryCount?: number | null;

    /** Recovery action that will be attempted, if any. */
    recoveryAction?: string | null;

    /** Additional structured context. */
    [key: string]: unknown;
}

/**
 * Log levels emitted by the Virtual Hook.
 */
export type VHLogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * A structured log entry produced by the Virtual Hook subsystem.
 */
export interface VHLogEntry {
    /** Event timestamp (epoch ms). */
    timestamp: number;

    /** Log level. */
    level: VHLogLevel;

    /** Event category. */
    event: string;

    /** Structured context payload. */
    context: VHLogContext;
}

/**
 * Logger contract. Injects a sink so the subsystem is testable
 * without the console.
 */
export interface VHLogger {
    /** Emit an informational event (state transition, etc.). */
    info(event: string, context: VHLogContext): void;

    /** Emit a warning (non-fatal divergence, timeout, etc.). */
    warn(event: string, context: VHLogContext): void;

    /** Emit an error (failure with recovery or terminal). */
    error(event: string, context: VHLogContext): void;

    /** Emit a debug event (verbose tracing). */
    debug(event: string, context: VHLogContext): void;
}

/**
 * Default console-backed logger.
 * Emits formatted single-line JSON preserving structured context.
 */
export class ConsoleVHLogger implements VHLogger {
    private readonly prefix = '[VH]';

    constructor(private readonly sink: (line: string) => void = console.log) {}

    info(event: string, context: VHLogContext): void {
        this.emit('info', event, context);
    }

    warn(event: string, context: VHLogContext): void {
        this.emit('warn', event, context);
    }

    error(event: string, context: VHLogContext): void {
        this.emit('error', event, context);
    }

    debug(event: string, context: VHLogContext): void {
        this.emit('debug', event, context);
    }

    private emit(level: VHLogLevel, event: string, context: VHLogContext): void {
        const entry: VHLogEntry = {
            timestamp: Date.now(),
            level,
            event,
            context,
        };
        this.sink(`${this.prefix} ${JSON.stringify(entry)}`);
    }
}