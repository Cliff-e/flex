export const EXECUTION_MODES = Object.freeze({ NORMAL: 'NORMAL', FAST: 'FAST' });

/**
 * Pending-tick threshold above which FAST reports the backlog.
 *
 * The queue itself is NEVER trimmed, sampled or debounced: exceeding this
 * threshold only produces a report, so a growing backlog becomes visible
 * instead of silently swallowing ticks.
 */
export const FAST_TICK_BACKLOG_REPORT_THRESHOLD = 25;

/**
 * Page-wide FAST tick-stream counters, aggregated over every XML engine.
 *
 * DIAGNOSTIC ONLY. With more than one engine/session alive these numbers are a
 * sum/last-writer mix and must NOT be used to judge acceptance. The authoritative
 * acceptance metric is the per-engine `tradeEngine.getTickStreamStats()`.
 *
 * Per-engine accounting model (the acceptance invariant):
 *
 *   received = processed + pending + dropped + unavailable
 *
 *   received    - unique live tick epochs recorded by this engine's tick listener
 *   processed   - epochs whose OWN tick data view was actually served to the
 *                 interpreter. A pop alone never counts (see markTickDataServed):
 *                 "popped" is not "evaluated".
 *   pending     - epochs still in the FIFO plus the epoch currently in flight
 *   dropped     - terminal discards: epochs thrown away at Stop/teardown, plus a
 *                 popped epoch whose iteration was aborted before it read its tick
 *   unavailable - TERMINAL INTEGRITY-FAILURE MARKER. An epoch that could NOT be
 *                 evaluated because its own data had already fallen outside the
 *                 available Deriv history window. Such an epoch is never evaluated
 *                 with another epoch's data and never counted as processed; the
 *                 engine that hit it enters an explicit integrity-failure/safe-stop
 *                 state (see reportFastTickIntegrityFailure) and stops draining.
 *
 * Acceptance criterion for FAST once the queue has drained with exact historical
 * data intact: received === processed, with dropped === 0 and unavailable === 0.
 * If unavailable > 0 the run did NOT complete successfully: FAST stopped safely
 * instead of evaluating a substitute epoch, and the per-engine telemetry reports
 * `failed === true` together with the affected epoch and the remaining backlog.
 */
export const tickStreamStats = {
    received: 0,
    processed: 0,
    dropped: 0,
    unavailable: 0,
    pending: 0,
    max_pending: 0,
    backlog_reports: 0,
    unavailable_reports: 0,
    integrity_failure_reports: 0,
};

/**
 * The documented FAST accounting invariant.
 *
 * Used by the telemetry and asserted by the regression tests so a silent bucket
 * (a tick that is neither evaluated, pending, discarded nor reported as
 * unavailable) can never pass unnoticed.
 */
export const tickStreamInvariantHolds = stats =>
    stats.received === stats.processed + stats.pending + stats.dropped + stats.unavailable;

/**
 * Reports an epoch whose own historical data is no longer available.
 *
 * This is the ONLY situation in which FAST cannot evaluate a received epoch with
 * its own data. It is reported explicitly (never silently swapped for a newer
 * tick, and never counted as processed). The engine then enters the explicit
 * integrity-failure/safe-stop state reported by reportFastTickIntegrityFailure.
 */
export const reportTickDataUnavailable = (epoch, oldest_available_epoch, symbol) => {
    // eslint-disable-next-line no-console
    console.warn(
        '[FAST] tick data unavailable: epoch ' +
            epoch +
            ' for ' +
            (symbol || 'unknown symbol') +
            ' is older than the available history window (oldest available epoch: ' +
            (oldest_available_epoch === null || oldest_available_epoch === undefined
                ? 'none'
                : oldest_available_epoch) +
            '). The epoch is accounted as "unavailable" and is NOT evaluated with another tick\'s data.',
        { epoch, oldest_available_epoch, symbol }
    );
};

/**
 * Reports the terminal FAST DATA INTEGRITY FAILURE / safe-stop.
 *
 * Raised exactly once per engine, at the moment the exact historical tick data of
 * the epoch being evaluated is found to have left the retained Deriv history
 * window. FAST does NOT substitute another (newer) tick, does NOT mark the epoch
 * as processed and does NOT continue draining the FIFO: the affected epoch is
 * recorded and the run stops safely with the remaining backlog left unprocessed.
 *
 * Deliberately console.error (unlike the console.warn of
 * reportTickDataUnavailable) so an integrity failure is clearly distinguishable
 * from a normal Stop/teardown.
 */
export const reportFastTickIntegrityFailure = ({ epoch, oldest_available_epoch, symbol, backlog }) => {
    const remaining = Array.isArray(backlog) ? backlog.length : 0;

    // eslint-disable-next-line no-console
    console.error(
        '[FAST] DATA INTEGRITY FAILURE: the exact tick data for epoch ' +
            epoch +
            ' for ' +
            (symbol || 'unknown symbol') +
            ' is no longer available (oldest available epoch: ' +
            (oldest_available_epoch === null || oldest_available_epoch === undefined
                ? 'none'
                : oldest_available_epoch) +
            '). No substitute tick was used and the epoch was NOT evaluated. ' +
            'FAST STOPPED SAFELY with ' +
            remaining +
            ' queued tick(s) left unprocessed (pending) - they were not evaluated, not substituted and not dropped.',
        { epoch, oldest_available_epoch, symbol, backlog }
    );
};

/** Called by an engine whenever its queue stays at or above the report threshold. */
export const reportTickBacklog = (pending, symbol, capacity) => {
    // eslint-disable-next-line no-console
    console.warn(
        '[FAST] tick backlog: ' + pending + ' tick(s) pending for ' + (symbol || 'unknown symbol') +
            ' while the interpreter is busy. No tick is dropped - the queue is replayed in order.',
        { pending, capacity, received: tickStreamStats.received, processed: tickStreamStats.processed }
    );
};

export const resetTickStreamStats = () => {
    tickStreamStats.received = 0;
    tickStreamStats.processed = 0;
    tickStreamStats.dropped = 0;
    tickStreamStats.unavailable = 0;
    tickStreamStats.pending = 0;
    tickStreamStats.max_pending = 0;
    tickStreamStats.backlog_reports = 0;
    tickStreamStats.unavailable_reports = 0;
    tickStreamStats.integrity_failure_reports = 0;
};

let _mode = EXECUTION_MODES.NORMAL;

const normalize = mode => (mode === EXECUTION_MODES.FAST ? EXECUTION_MODES.FAST : EXECUTION_MODES.NORMAL);

export const executionMode = {
    get mode() {
        return _mode;
    },
    isFast() {
        return _mode === EXECUTION_MODES.FAST;
    },
    set(mode) {
        _mode = normalize(mode);
        return _mode;
    },
    toggle() {
        return executionMode.set(_mode === EXECUTION_MODES.FAST ? EXECUTION_MODES.NORMAL : EXECUTION_MODES.FAST);
    },
    reset() {
        _mode = EXECUTION_MODES.NORMAL;
        resetTickStreamStats();
        return _mode;
    },
};

export default executionMode;