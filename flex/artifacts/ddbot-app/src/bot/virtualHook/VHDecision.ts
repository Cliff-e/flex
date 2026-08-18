// =============================================================
// VHDecision — Normalized output from VirtualHookEngine
//
// Every trading engine receives exactly one of these four
// decisions after submitting a TradeCandidate.
// =============================================================

/**
 * Possible outcomes from a Virtual Hook evaluation.
 *
 * AUTHORIZED  — Virtual Hook permits a real trade. The caller
 *               should proceed with the funded buy.
 * REJECTED    — Virtual Hook has vetoed this signal. The caller
 *               should drop the signal entirely.
 * RETRY       — A transient error occurred. The caller may re-submit
 *               the candidate after a delay. (Rare — usually handled
 *               internally by the engine via retries.)
 * STOPPED     — An irrecoverable error occurred or the engine was
 *               explicitly aborted. No further action should be taken
 *               on this signal.
 */
export enum VHDecision {
    AUTHORIZED = 'AUTHORIZED',
    REJECTED = 'REJECTED',
    RETRY = 'RETRY',
    STOPPED = 'STOPPED',
}