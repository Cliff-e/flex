/**
 * VirtualHookRuntime
 *
 * Pre-trade filter. Decides whether a real trade is allowed based on
 * simulated (virtual) tick observations against live market data.
 *
 * This is NOT a delay, NOT a timer, and NOT a warm-up cycler.
 * It is a trade filter: each trade signal is independently evaluated,
 * and the real trade is either permitted or discarded based on the
 * virtual outcomes observed.
 *
 * Spec
 * ────
 *   vh_max_steps — maximum virtual observations allowed per signal
 *   vh_min_wins  — minimum virtual wins required to permit the real trade
 *   vh_stake     — stake used only for virtual simulation display (never touches real trades)
 *
 * Per-signal flow
 * ───────────────
 *   1. Trade signal arrives → Purchase._runVirtualFilter() is called
 *   2. startSignal()        → reset per-signal counters
 *   3. For each live tick:
 *        recordTick(won) → 'PROCEED' | 'DISCARD' | 'CONTINUE'
 *        PROCEED  — vh_min_wins reached → execute real trade
 *        DISCARD  — vh_max_steps reached without enough wins → drop signal
 *        CONTINUE — keep observing
 *   4. After either outcome, counters are reset automatically.
 *      VH is ready for the next independent trade signal.
 *
 * Example (vh_max_steps=5, vh_min_wins=3)
 * ────────────────────────────────────────
 *   Tick 1 → Loss  (wins=0, steps=1) → CONTINUE
 *   Tick 2 → Win   (wins=1, steps=2) → CONTINUE
 *   Tick 3 → Win   (wins=2, steps=3) → CONTINUE
 *   Tick 4 → Loss  (wins=2, steps=4) → CONTINUE
 *   Tick 5 → Win   (wins=3, steps=5) → PROCEED  ← real trade executed
 *
 * Example (vh_max_steps=5, vh_min_wins=4)
 * ────────────────────────────────────────
 *   Tick 1 → Win   (wins=1, steps=1) → CONTINUE
 *   Tick 2 → Loss  (wins=1, steps=2) → CONTINUE
 *   Tick 3 → Win   (wins=2, steps=3) → CONTINUE
 *   Tick 4 → Loss  (wins=2, steps=4) → CONTINUE
 *   Tick 5 → Win   (wins=3, steps=5) → DISCARD  ← signal dropped (3 < 4)
 */
export class VirtualHookRuntime {
    // ── Configuration ────────────────────────────────────────────────────────

    /** Maximum number of virtual observations allowed per signal. */
    _maxSteps = 5;

    /** Minimum virtual wins required to allow the real trade. */
    _minWins = 3;

    /**
     * Virtual stake — used only for display/reference purposes.
     * NEVER modifies trade stake, recovery stake, martingale stake,
     * or bulk purchase stake.
     */
    _stake = 1.0;

    // ── Runtime state ────────────────────────────────────────────────────────

    _enabled = false;
    _active  = false;  // true while a signal is actively being evaluated
    _steps   = 0;      // virtual observations in the current signal
    _wins    = 0;      // virtual wins in the current signal

    // ── Configuration API ────────────────────────────────────────────────────

    /**
     * Set filter parameters.  Safe to call before or after enable().
     * Takes effect from the next signal evaluation.
     *
     * @param {number} maxSteps  Maximum observations per signal (min 1).
     * @param {number} minWins   Minimum wins required to permit the trade (min 1).
     * @param {number} [stake]   Virtual stake — display only, never affects real purchases.
     */
    configure(maxSteps, minWins, stake) {
        this._maxSteps = Math.max(1, Number(maxSteps) || 5);
        this._minWins  = Math.max(1, Number(minWins)  || 3);
        if (stake !== undefined && stake !== null) {
            this._stake = Number(stake) || 1.0;
        }
    }

    // ── Lifecycle API ────────────────────────────────────────────────────────

    /** Enable the Virtual Hook. */
    enable() {
        this._enabled = true;
    }

    /** Disable the Virtual Hook and abort any running signal evaluation. */
    disable() {
        this._enabled = false;
        this._resetSignal();
    }

    /**
     * Returns true when the hook has been enabled.
     * Use this to decide whether _runVirtualFilter() should run.
     */
    isEnabled() {
        return this._enabled;
    }

    /**
     * Abort any in-progress signal evaluation without changing enabled state.
     * Useful for external systems that need to cancel a running sequence.
     */
    reset() {
        this._resetSignal();
    }

    // ── Per-signal API ───────────────────────────────────────────────────────

    /**
     * Called once when a new trade signal arrives and VH is enabled.
     * Resets per-signal counters so each signal is evaluated independently.
     */
    startSignal() {
        this._steps  = 0;
        this._wins   = 0;
        this._active = true;
    }

    /**
     * Record one virtual tick observation and decide the next action.
     *
     * Must be called after startSignal() and once per distinct market tick.
     *
     * @param {boolean} won  Whether the simulated contract would have been a win.
     * @returns {'PROCEED'|'DISCARD'|'CONTINUE'}
     *   PROCEED  — vh_min_wins reached → execute the real trade immediately
     *   DISCARD  — vh_max_steps exhausted without enough wins → drop this signal
     *   CONTINUE — neither threshold met yet → keep observing
     */
    recordTick(won) {
        this._steps++;
        if (won) this._wins++;

        if (this._wins >= this._minWins) {
            this._resetSignal();
            return 'PROCEED';
        }
        if (this._steps >= this._maxSteps) {
            this._resetSignal();
            return 'DISCARD';
        }
        return 'CONTINUE';
    }

    // ── Query API ────────────────────────────────────────────────────────────

    /**
     * Returns true while a signal is actively being evaluated.
     * Called by the Virtual Hook Status Blockly block.
     */
    getStatus() {
        return this._active;
    }

    /** Current step count within the active signal (or 0 if idle). */
    get steps()    { return this._steps; }

    /** Current win count within the active signal (or 0 if idle). */
    get wins()     { return this._wins; }

    /** Configured maximum steps. */
    get maxSteps() { return this._maxSteps; }

    /** Configured minimum wins. */
    get minWins()  { return this._minWins; }

    /** Virtual stake (display only — never used for real trade sizing). */
    get stake()    { return this._stake; }

    // ── Backward-compatibility stubs ─────────────────────────────────────────
    // The old implementation was a warm-up cycler with virtual/real phases.
    // These stubs ensure any remaining callers do not throw.  They are no-ops.

    /** @deprecated VH is now a per-signal filter. Use isEnabled() instead. */
    isVirtualMode() { return false; }

    /** @deprecated No longer needed — virtual outcomes are evaluated in _runVirtualFilter. */
    onVirtualTradeComplete() {}

    /** @deprecated No longer needed — VH does not cycle on real trade outcomes. */
    onRealTradeComplete() {}

    /** @deprecated Phase transitions are handled internally by recordTick(). */
    enterVirtualMode() {}

    /** @deprecated Phase transitions are handled internally by recordTick(). */
    enterRealMode() {}

    // ── Private helpers ──────────────────────────────────────────────────────

    _resetSignal() {
        this._steps  = 0;
        this._wins   = 0;
        this._active = false;
    }

    // ── Static helpers ───────────────────────────────────────────────────────

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
