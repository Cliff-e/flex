/**
 * VirtualHookRuntime
 *
 * Single source of truth for all Virtual Hook state.
 * Zero dependencies on the trade engine, Blockly, or the DOM — pure runtime
 * logic that can be imported and consumed by any future system.
 *
 * Lifecycle
 * ─────────
 *   configure()   → set warm-up parameters before enabling
 *   enable()      → enter virtual mode; bot runs simulated trades
 *   [virtual trades complete] → enterRealMode() called automatically
 *   [real wins accumulate]    → enterVirtualMode() called automatically
 *   disable()     → exit virtual hook; bot runs real trades only
 *   reset()       → clear counters / history (hook stays enabled/disabled)
 *
 * Future consumers
 * ────────────────
 *   Exit Digit History Engine, Recovery Engine, AI Strategy Engine,
 *   Statistics Engine, Analytics Blocks — import this module and read
 *   state through the public API.  No duplicate tracking needed.
 */
export class VirtualHookRuntime {
    // ── Configuration (set via configure(), safe before or after enable()) ───

    /** Virtual trades required per warm-up sequence before real mode. */
    virtualTradeLimit = 21;

    /** Consecutive real wins required to trigger a new virtual sequence. */
    realWinLimit = 1;

    // ── Runtime state (private by convention — use the public API) ───────────

    _enabled = false;
    _virtualMode = false;
    _virtualTradeCounter = 0;
    _realWinCounter = 0;
    _virtualHistory = [];
    _lastVirtualResult = null;
    _currentPhase = 'real'; // 'virtual' | 'real'

    // ── Configuration API ─────────────────────────────────────────────────────

    /**
     * Set warm-up parameters.  May be called before or after enable().
     * If called mid-sequence the new limits take effect on the next boundary.
     *
     * @param {number} virtualTradeLimit  Trades per virtual sequence (min 1).
     * @param {number} realWinLimit       Consecutive real wins before reset (min 1).
     */
    configure(virtualTradeLimit, realWinLimit) {
        this.virtualTradeLimit = Math.max(1, Number(virtualTradeLimit) || 21);
        this.realWinLimit = Math.max(1, Number(realWinLimit) || 1);
    }

    // ── Lifecycle API ─────────────────────────────────────────────────────────

    /**
     * Enable the Virtual Hook and immediately enter virtual mode.
     * If already enabled this is a no-op — existing state is preserved.
     */
    enable() {
        if (this._enabled) return;
        this._enabled = true;
        this.enterVirtualMode();
    }

    /**
     * Disable the Virtual Hook and clear all runtime state.
     * The bot reverts immediately to unconditional real trading.
     */
    disable() {
        this._enabled = false;
        this._clearState();
    }

    /**
     * Transition into virtual (simulated-trade) mode.
     * Called automatically by enable() and by onRealTradeComplete() when the
     * real-wins threshold is reached.  May also be called externally.
     */
    enterVirtualMode() {
        this._virtualMode = true;
        this._virtualTradeCounter = 0;
        this._virtualHistory = [];
        this._lastVirtualResult = null;
        this._currentPhase = 'virtual';
    }

    /**
     * Transition into real-trade mode.
     * Called automatically when the virtual trade limit is reached.
     * The real-win counter is reset so accumulation starts fresh.
     */
    enterRealMode() {
        this._virtualMode = false;
        this._realWinCounter = 0;
        this._currentPhase = 'real';
    }

    /**
     * Reset all counters and history without changing the enabled state.
     * Useful for external systems that need to restart a sequence mid-run.
     */
    reset() {
        this._clearState();
    }

    // ── Trade event API ───────────────────────────────────────────────────────

    /**
     * Record the outcome of a completed virtual trade and advance the counter.
     * Transitions to real mode automatically when the limit is reached.
     * Must only be called for confirmed-valid virtual evaluations — never for
     * market-closed or error cases.
     *
     * @param {boolean} won  Whether the simulated trade would have been a win.
     */
    onVirtualTradeComplete(won) {
        const result = won ? 'win' : 'loss';
        this._virtualHistory.push(result);
        this._lastVirtualResult = result;
        this._virtualTradeCounter++;

        if (this._virtualTradeCounter >= this.virtualTradeLimit) {
            this.enterRealMode();
        }
    }

    /**
     * Record the outcome of a completed real trade and update the win counter.
     * Re-enters virtual mode automatically when the configured threshold is met.
     * No-op when the hook is disabled.
     *
     * @param {boolean} won  Whether the real trade was a win.
     */
    onRealTradeComplete(won) {
        if (!this._enabled) return;

        if (won) {
            this._realWinCounter++;
            if (this._realWinCounter >= this.realWinLimit) {
                this.enterVirtualMode();
            }
        } else {
            // A loss resets the consecutive win streak.
            this._realWinCounter = 0;
        }
    }

    // ── Query API (primary interface for all consumers) ───────────────────────

    /**
     * Returns true when the hook is enabled AND actively in virtual mode.
     * This is the primary gate checked before each purchase.
     *
     * @returns {boolean}
     */
    isVirtualMode() {
        return this._enabled && this._virtualMode;
    }

    /**
     * Returns true when the hook has been enabled (regardless of phase).
     *
     * @returns {boolean}
     */
    isEnabled() {
        return this._enabled;
    }

    /**
     * Status value exposed to the Virtual Hook Status Blockly block and
     * any future strategy/analytics block.
     * Equivalent to isVirtualMode() — kept as a named alias for clarity.
     *
     * @returns {boolean}
     */
    getStatus() {
        return this.isVirtualMode();
    }

    // ── Read-only state for future consumers ──────────────────────────────────

    /** Immutable snapshot of the virtual trade history: ('win' | 'loss')[]. */
    get virtualHistory() {
        return [...this._virtualHistory];
    }

    /** Result of the most recently completed virtual trade, or null. */
    get lastVirtualResult() {
        return this._lastVirtualResult;
    }

    /** Current execution phase: 'virtual' | 'real'. */
    get currentPhase() {
        return this._currentPhase;
    }

    /** Number of virtual trades completed in the current sequence. */
    get virtualTradeCounter() {
        return this._virtualTradeCounter;
    }

    /** Consecutive real wins since the last virtual sequence ended. */
    get realWinCounter() {
        return this._realWinCounter;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    _clearState() {
        this._virtualMode = false;
        this._virtualTradeCounter = 0;
        this._realWinCounter = 0;
        this._virtualHistory = [];
        this._lastVirtualResult = null;
        this._currentPhase = 'real';
    }

    // ── Static helpers (pure functions, no state) ─────────────────────────────

    /**
     * Determine whether a virtual trade would have been a win based on the
     * last tick digit, the contract type, and the active prediction override.
     *
     * Pure function — no side effects, safe to call from any context.
     *
     * @param {string}      contractType  e.g. 'DIGITOVER'
     * @param {number}      lastDigit     0–9, parsed from the last tick value
     * @param {number|null} prediction    Active prediction (0–9), or null to use defaults
     * @returns {boolean}
     */
    static determineOutcome(contractType, lastDigit, prediction) {
        const pred = prediction !== null && prediction !== undefined ? Number(prediction) : null;

        switch (contractType) {
            case 'DIGITOVER':
                // Win if last digit is strictly greater than the barrier.
                return pred !== null ? lastDigit > pred : lastDigit > 4;
            case 'DIGITUNDER':
                // Win if last digit is strictly less than the barrier.
                return pred !== null ? lastDigit < pred : lastDigit < 5;
            case 'DIGITMATCH':
                // Win if last digit exactly equals the prediction.
                return pred !== null ? lastDigit === pred : false;
            case 'DIGITDIFF':
                // Win if last digit differs from the prediction.
                return pred !== null ? lastDigit !== pred : lastDigit !== 5;
            case 'DIGITEVEN':
                return lastDigit % 2 === 0;
            case 'DIGITODD':
                return lastDigit % 2 !== 0;
            case 'CALL':
            case 'CALLE':
                // Simplified proxy: upward movement correlated with higher digits.
                return lastDigit > 4;
            case 'PUT':
            case 'PUTE':
                return lastDigit <= 4;
            default:
                // Fallback for unknown types — use digit parity.
                return lastDigit % 2 === 0;
        }
    }
}
