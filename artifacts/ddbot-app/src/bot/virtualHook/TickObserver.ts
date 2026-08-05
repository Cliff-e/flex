// =============================================================
// TickObserver — Shared tick observation interface
//
// Virtual Hook observes market ticks through this interface.
// It does NOT create a new WebSocket or tick manager. It consumes
// the existing shared tick infrastructure.
//
// One market stream. Multiple consumers. Virtual Hook is one.
// =============================================================

/**
 * A single market tick observed by the Virtual Hook.
 */
export interface VHTick {
    /** Quote value. */
    quote: number;

    /** Epoch (seconds). */
    epoch: number;

    /** Last digit (0–9) extracted from the quote. */
    digit: number;
}

/**
 * Contract for the shared tick observation layer.
 *
 * XML and AI integrations both supply an implementation backed by
 * their existing tick monitors (ticksService / PublicTickManager).
 * The Virtual Hook engine itself never manages a WebSocket.
 */
export interface TickObserver {
    /**
     * Start observing ticks for the given symbol.
     *
     * @param symbol - Market symbol (e.g. 'R_100').
     * @param onTick - Callback invoked for each new tick.
     * @returns A promise resolving when observation is active.
     */
    start(symbol: string, onTick: (tick: VHTick) => void): Promise<void>;

    /**
     * Stop observing ticks. Idempotent — safe to call multiple times.
     */
    stop(): Promise<void>;

    /**
     * Whether observation is currently active.
     */
    isActive(): boolean;
}