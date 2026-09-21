import { applyMiddleware, createStore } from 'redux';
import { thunk } from 'redux-thunk';
import { localize } from '@deriv-com/translations';
import { createError } from '../../../utils/error';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { checkBlocksForProposalRequest, doUntilDone } from '../utils/helpers';
import { expectInitArg } from '../utils/sanitize';
import {
    executionMode,
    FAST_TICK_BACKLOG_REPORT_THRESHOLD,
    reportFastTickIntegrityFailure,
    reportTickBacklog,
    reportTickDataUnavailable,
    tickStreamStats,
} from '../utils/execution-mode';
import { proposalsReady, start } from './state/actions';
import * as constants from './state/constants';
import rootReducer from './state/reducers';
import ActiveContract from './ActiveContract';
import Balance from './Balance';
import OpenContract from './OpenContract';
import Proposal from './Proposal';
import Purchase from './Purchase';
import Sell from './Sell';
import Ticks, { isEpochInTickList } from './Ticks';
import Total from './Total';

const watchBefore = (engine, watch_scope = watchScope) =>
    watch_scope({
        engine,
        store: engine.store,
        stopScope: constants.DURING_PURCHASE,
        passScope: constants.BEFORE_PURCHASE,
        passFlag: 'proposalsReady',
    });

const watchDuring = (engine, watch_scope = watchScope) =>
    watch_scope({
        engine,
        store: engine.store,
        stopScope: constants.STOP,
        passScope: constants.DURING_PURCHASE,
        passFlag: 'openContract',
    });

/* The watchScope function is called randomly and resets the prevTick
 * which leads to the same problem we try to solve. So prevTick is isolated
 */
let prevTick;
const watchScope = ({ store, stopScope, passScope, passFlag }) => {
    // in case watch is called after stop is fired
    if (store.getState().scope === stopScope) {
        return Promise.resolve(false);
    }
    return new Promise(resolve => {
        const unsubscribe = store.subscribe(() => {
            const newState = store.getState();

            if (newState.newTick === prevTick) return;
            prevTick = newState.newTick;

            if (newState.scope === passScope && newState[passFlag]) {
                unsubscribe();
                resolve(true);
            }

            if (newState.scope === stopScope) {
                unsubscribe();
                resolve(false);
            }
        });
    });
};

/* FAST execution path (see ../utils/execution-mode.js).
 *
 * NORMAL keeps watchScope() above exactly as it is.
 *
 * FAST is a LOSSLESS tick consumer: every unique live tick epoch that reaches the
 * XML bot must be evaluated by the interpreter exactly once, in arrival order,
 * even while the interpreter is still busy with an earlier tick.
 *
 * watchScope() cannot do that: it registers its store subscription only after the
 * previous loop body finished, so a tick dispatched in that window has no listener
 * and is silently dropped.
 *
 * FAST therefore keeps a per-engine FIFO queue of received epochs plus a
 * processing cursor:
 *
 *   tick epoch -> recordTickEpoch() -> queue.push(epoch)          (never dropped)
 *   watch()    -> queue.shift()     -> processing cursor = epoch  (FIFO, in order)
 *
 * The cursor doubles as the tick data view for the interpreter: while an epoch is
 * being processed, the tick APIs are trimmed to epochs <= that epoch, so a
 * backlogged Tick 2 is evaluated with Tick 2 data and Tick 2 epoch instead of the
 * newest tick. That is what makes received === processed observable in the XML
 * logic, rather than merely measuring latency.
 *
 * Guarantees:
 *   - an epoch is recorded once (duplicate delivery is ignored),
 *   - an epoch is consumed once (a unique queue entry is shifted),
 *   - order is FIFO (arrival / epoch order),
 *   - nothing is dropped when the queue grows; the backlog is reported instead,
 *   - the interpreter can never spin (an empty queue never resolves a watch),
 *   - state is per engine instance, never module global, so two XML bots can not
 *     consume each other ticks.
 *
 * Accounting (per engine, the acceptance metric — see execution-mode.js):
 *
 *   received = processed + pending + dropped + unavailable
 *
 *   processed   is incremented only when the epoch's OWN tick data view is served
 *               to the interpreter (markTickDataServed). Popping alone does NOT
 *               count: "popped" is not "evaluated".
 *   pending     is the FIFO depth plus the epoch currently in flight.
 *   unavailable is the TERMINAL INTEGRITY-FAILURE marker: the epoch's own data has
 *               already left the available Deriv history window, so it is reported
 *               and never evaluated with a different (newer) epoch's data. FAST
 *               then enters an explicit integrity-failure/safe-stop state: the
 *               affected epoch is recorded, no further epoch is popped, and the
 *               remaining backlog stays `pending` instead of being drained into
 *               more `unavailable`.
 *   dropped     records terminal discards (Stop / teardown) and an epoch whose
 *               iteration was aborted before it could read its tick.
 */
const fastTickStreams = new WeakMap();

const getFastTickStream = engine => {
    let stream = fastTickStreams.get(engine);

    if (!stream) {
        stream = {
            queue: [],
            processing: null,
            // Per-epoch resolution of the in-flight epoch: an epoch is resolved
            // exactly once, either as "served" (processed) or as "unavailable".
            processing_resolved: false,
            processing_unavailable: false,
            last_recorded: null,
            received: 0,
            processed: 0,
            dropped: 0,
            unavailable: 0,
            max_pending: 0,
            backlog_reported: false,
            unavailable_reported: false,
            // Terminal FAST integrity-failure / safe-stop. Set once when the exact
            // historical data of the in-flight epoch has left the retained Deriv
            // history window; nothing is popped or evaluated afterwards.
            failed: false,
            integrity_failure: null,
        };
        fastTickStreams.set(engine, stream);
    }

    return stream;
};

/**
 * The epoch whose data the interpreter must see right now.
 *
 * While an epoch is being processed this is that epoch. When nothing has been
 * popped yet but the FIFO holds epochs, it is the FIFO HEAD: a queued epoch must
 * never be evaluated against a newer tick, and a tick-data read performed outside
 * the FIFO (the generated loop calls TickAnalysis() between two watches) must
 * resolve against the oldest pending epoch, not the newest live one.
 */
const getViewEpoch = stream =>
    stream.processing === null || stream.processing === undefined
        ? stream.queue.length
            ? stream.queue[0]
            : null
        : stream.processing;

/**
 * The in-flight epoch whose iteration ended without reading its tick.
 *
 * The generated FAST loop always reads the tick data of the epoch it was woken
 * for, so this can only happen when an iteration is aborted (Stop / error). It is
 * accounted explicitly as `dropped` — never silently discarded.
 */
const finalizeAbandonedInFlight = (engine, stream) => {
    if (stream.processing === null || stream.processing === undefined) return;

    if (!stream.processing_resolved) {
        stream.dropped += 1;
        tickStreamStats.dropped += 1;
    }

    stream.processing = null;
    stream.processing_resolved = false;
    stream.processing_unavailable = false;
};

/**
 * Counts the epoch that has been popped but not yet dispositioned.
 *
 * It is still part of `pending`: a popped epoch is NOT "processed" until its own
 * tick data has actually been served (markTickDataServed) or accounted as
 * unavailable (markTickDataUnavailable).
 */
const countInFlight = stream =>
    stream.processing !== null && stream.processing !== undefined && !stream.processing_resolved ? 1 : 0;

const syncPending = stream => {
    tickStreamStats.pending = stream.queue.length + countInFlight(stream);

    if (tickStreamStats.pending > tickStreamStats.max_pending) {
        tickStreamStats.max_pending = tickStreamStats.pending;
    }
};

/** Records a unique received live tick epoch. Returns true when it was queued. */
const pushFastTickEpoch = (engine, epoch) => {
    if (!executionMode.isFast() || epoch === undefined || epoch === null) return false;

    const stream = getFastTickStream(engine);

    // Duplicate delivery (the same epoch again, or an epoch still queued) must not
    // create a second evaluation.
    if (epoch === stream.last_recorded) return false;
    if (stream.queue.indexOf(epoch) !== -1) return false;

    stream.last_recorded = epoch;
    stream.queue.push(epoch);
    stream.received += 1;

    if (stream.queue.length > stream.max_pending) stream.max_pending = stream.queue.length;

    tickStreamStats.received += 1;
    syncPending(stream);

    // Backlog is reported, never trimmed.
    if (stream.queue.length >= FAST_TICK_BACKLOG_REPORT_THRESHOLD && !stream.backlog_reported) {
        stream.backlog_reported = true;
        tickStreamStats.backlog_reports += 1;
        reportTickBacklog(stream.queue.length, engine.symbol, FAST_TICK_BACKLOG_REPORT_THRESHOLD);
    }

    return true;
};

/**
 * Consumes the OLDEST pending tick epoch. Returns null when nothing is pending.
 *
 * The pop only moves the cursor: it does NOT count the epoch as processed. The
 * epoch is accounted when its own tick data has actually been served
 * (markTickDataServed) or when its data turned out to be unavailable
 * (markTickDataUnavailable).
 */
const popFastTickEpoch = engine => {
    const stream = getFastTickStream(engine);

    // SAFE-STOP: once FAST has hit a data-integrity failure nothing else may be
    // popped. The remaining backlog stays pending and identifiable.
    if (stream.failed) return null;

    // The previous iteration is over: if it never read its tick, that epoch was
    // not evaluated and must be surfaced instead of silently disappearing.
    finalizeAbandonedInFlight(engine, stream);

    const epoch = stream.queue.shift();

    if (epoch === undefined) {
        syncPending(stream);
        return null;
    }

    stream.processing = epoch;
    stream.processing_resolved = false;
    stream.processing_unavailable = false;
    if (!stream.queue.length) stream.backlog_reported = false;
    syncPending(stream);

    return epoch;
};

/**
 * Releases the tick data view back to the live feed.
 *
 * Called when a watch is about to wait, i.e. nothing is pending: an idle engine then
 * reads live ticks exactly like NORMAL. The view is re-pinned to the next consumed
 * epoch before any XML logic runs for it, so no queued tick is ever evaluated against
 * newer data. While epochs are still queued the cursor is NOT released: it falls back
 * to the FIFO head (see getViewEpoch), so a tick-data read performed outside the FIFO
 * can never jump ahead of it.
 */
const releaseFastTickCursor = engine => {
    const stream = getFastTickStream(engine);

    if (!stream.queue.length) {
        finalizeAbandonedInFlight(engine, stream);
        syncPending(stream);
    }
};

/**
 * Terminal teardown: discards everything still pending/ in flight and records it.
 *
 * Nothing is ever dropped silently — the discarded epochs are added to `dropped`
 * so `received === processed + pending + dropped + unavailable` keeps holding.
 *
 * A FAST integrity failure is NOT erased here: `failed` and `integrity_failure`
 * survive a Stop/teardown so the run can still be told apart from a normal stop and
 * the affected epoch / remaining backlog stay identifiable.
 */
const clearFastTickStream = engine => {
    const stream = getFastTickStream(engine);
    const discarded = stream.queue.length + countInFlight(stream);

    stream.queue.length = 0;
    stream.processing = null;
    stream.processing_resolved = false;
    stream.processing_unavailable = false;
    stream.backlog_reported = false;

    if (discarded) {
        stream.dropped += discarded;
        tickStreamStats.dropped += discarded;
    }

    syncPending(stream);
};

/**
 * Accounts an epoch as successfully served.
 *
 * Called by the tick-data view (Ticks.js) once the exact epoch the view is pinned
 * to has been resolved against the tick list, i.e. its OWN data was handed to the
 * interpreter. This is what makes `processed` mean "evaluated with its own data"
 * instead of "popped from the FIFO".
 */
const markTickDataServed = (engine, epoch) => {
    const stream = getFastTickStream(engine);

    // Only the epoch that was popped can be accounted. A pre-pop read of the FIFO
    // head is not an evaluation of it yet (the pop will account it).
    if (stream.processing === null || stream.processing === undefined) return false;
    if (stream.processing !== epoch) return false;
    if (stream.processing_resolved) return false;

    stream.processing_resolved = true;
    stream.processed += 1;
    tickStreamStats.processed += 1;
    syncPending(stream);

    return true;
};

/**
 * Accounts an epoch as UNAVAILABLE and enters the FAST integrity-failure safe-stop.
 *
 * The epoch's own data is no longer inside the available Deriv history window, so
 * it can not be evaluated against its own data. FAST never substitutes a newer
 * tick for it: the epoch is excluded from `processed`, the affected epoch is
 * recorded, and the run stops safely BEFORE any other queued epoch can be
 * evaluated. The remaining backlog is deliberately left `pending` (not drained,
 * not converted into more `unavailable`, not dropped).
 */
const markTickDataUnavailable = (engine, epoch, oldest_available_epoch) => {
    const stream = getFastTickStream(engine);

    if (stream.processing === null || stream.processing === undefined) return false;
    if (stream.processing !== epoch) return false;
    if (stream.processing_resolved) return false;

    stream.processing_resolved = true;
    stream.processing_unavailable = true;
    stream.unavailable += 1;
    tickStreamStats.unavailable += 1;
    syncPending(stream);

    if (!stream.unavailable_reported) {
        stream.unavailable_reported = true;
        tickStreamStats.unavailable_reports += 1;
        reportTickDataUnavailable(epoch, oldest_available_epoch, engine.symbol);
    }

    // Terminal integrity failure: preserve the affected epoch and the remaining
    // backlog, then refuse to drain any further. Reported exactly once.
    if (!stream.failed) {
        const backlog = stream.queue.slice();

        stream.failed = true;
        stream.integrity_failure = { epoch, oldest_available_epoch, backlog };
        tickStreamStats.integrity_failure_reports += 1;
        reportFastTickIntegrityFailure({
            epoch,
            oldest_available_epoch,
            symbol: engine.symbol,
            backlog,
        });
    }

    return true;
};

const watchScopeFast = ({ engine, store, stopScope, passScope, passFlag }) => {
    // Mirrors the NORMAL early exit: watch called after stop was fired.
    if (store.getState().scope === stopScope) {
        return Promise.resolve(false);
    }

    // SAFE-STOP: a FAST data-integrity failure is terminal. The engine refuses to
    // wake for any further epoch, so no queued tick can be evaluated after the
    // failure and the backlog stays identifiable.
    if (getFastTickStream(engine).failed) {
        return Promise.resolve(false);
    }

    const can_proceed = () => {
        const state = store.getState();
        return state.scope === passScope && Boolean(state[passFlag]);
    };

    const has_pending = () => getFastTickStream(engine).queue.length > 0;

    // Lossless fast path: ticks already queued while the engine was busy. The
    // OLDEST one is consumed so every received epoch is processed, in order.
    if (can_proceed() && has_pending()) {
        popFastTickEpoch(engine);
        return Promise.resolve(true);
    }

    // Nothing pending: fall back to the live tick view while parked.
    releaseFastTickCursor(engine);

    return new Promise(resolve => {
        let settled = false;
        let unsubscribe = () => {};

        const settle = value => {
            if (settled) return;
            settled = true;
            unsubscribe();
            if (value) popFastTickEpoch(engine);
            resolve(value);
        };

        const check = () => {
            const state = store.getState();

            if (state.scope === stopScope) {
                settle(false);
                return;
            }

            if (can_proceed() && has_pending()) settle(true);
        };

        unsubscribe = store.subscribe(check);
        check();
    });
};

export default class TradeEngine extends ActiveContract(Balance(Purchase(Sell(OpenContract(Proposal(Ticks(Total(class {})))))))) {
    constructor($scope) {
        super();
        this.observer = $scope.observer;
        this.$scope = $scope;
        this.observe();
        this.data = {
            contract: {},
            proposals: [],
        };
        this.subscription_id_for_accumulators = null;
        this.is_proposal_requested_for_accumulators = false;
        this.store = createStore(rootReducer, applyMiddleware(thunk));
    }

    init(...args) {
        const [token, options] = expectInitArg(args);
        const { symbol } = options;

        this.initArgs = args;
        this.options = options;
        this.startPromise = this.loginAndGetBalance(token);

        if (!this.checkTicksPromiseExists()) this.watchTicks(symbol);
    }

    start(tradeOptions) {
        if (!this.options) {
            throw createError('NotInitialized', localize('Bot.init is not called'));
        }

        globalObserver.emit('bot.running');
        // Reset the explicit in-progress guard so each new bot run starts clean.
        this._purchaseInProgress = false;

        const validated_trade_options = this.validateTradeOptions(tradeOptions);

        this.tradeOptions = { ...validated_trade_options, symbol: this.options.symbol };
        this.store.dispatch(start());
        this.checkLimits(validated_trade_options);

        this.makeDirectPurchaseDecision();
    }

    loginAndGetBalance(token) {
        if (this.token === token) {
            return Promise.resolve();
        }
        // for strategies using total runs, GetTotalRuns function is trying to get loginid and it gets called before Proposals calls.
        // the below required loginid to be set in Proposal calls where loginAndGetBalance gets resolved.
        // Earlier this used to happen as soon as we get ticks_history response and by the time GetTotalRuns gets called we have required info.
        this.accountInfo = api_base.account_info;
        this.token = api_base.token;
        return new Promise(resolve => {
            // Try to recover from a situation where API doesn't give us a correct response on
            // "proposal_open_contract" which would make the bot run forever. When there's a "sell"
            // event, wait a couple seconds for the API to give us the correct "proposal_open_contract"
            // response, if there's none after x seconds. Send an explicit request, which _should_
            // solve the issue. This is a backup!
            const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data.msg_type === 'transaction' && data.transaction.action === 'sell') {
                    this.transaction_recovery_timeout = setTimeout(() => {
                        const { contract } = this.data;
                        const is_same_contract = contract.contract_id === data.transaction.contract_id;
                        const is_open_contract = contract.status === 'open';
                        if (is_same_contract && is_open_contract) {
                            doUntilDone(() => {
                                api_base.api.send({ proposal_open_contract: 1, contract_id: contract.contract_id });
                            }, ['PriceMoved']);
                        }
                    }, 1500);
                }
                resolve();
            });
            api_base.pushSubscription(subscription);
        });
    }

    observe() {
        this.observeOpenContract();
        this.observeBalance();
        this.observeProposals();
    }

    watch(watchName) {
        // FAST swaps only the tick-wait implementation; every other part of the
        // engine (purchase, proposals, recovery, stop) is shared with NORMAL.
        const watch_scope = executionMode.isFast() ? watchScopeFast : watchScope;

        if (watchName === 'before') {
            return watchBefore(this, watch_scope);
        }
        return watchDuring(this, watch_scope);
    }

    /**
     * FAST: records a unique received live tick epoch for this engine.
     *
     * Called by Ticks.watchTicks immediately BEFORE the NEW_TICK dispatch, so the
     * epoch is queued before any watch can be resolved by that dispatch.
     */
    recordTickEpoch(epoch) {
        return pushFastTickEpoch(this, epoch);
    }

    /**
     * FAST: the epoch whose tick data the interpreter must see.
     *
     * Returns the epoch currently being processed, and — while epochs are still
     * queued — the FIFO HEAD instead of the newest live tick. That is what keeps a
     * tick-data read performed outside the FIFO (the generated loop calls
     * `BinaryBotPrivateTickAnalysis()` between two watches) from jumping ahead of
     * the queue: a queued epoch is never evaluated against a newer tick, and the
     * newest epoch can therefore never be evaluated twice.
     */
    getProcessingTickEpoch() {
        return getViewEpoch(getFastTickStream(this));
    }

    /**
     * FAST: true while the epoch the interpreter must see can NOT be evaluated with
     * its OWN historical data.
     *
     * Called by the generated FAST loop (through
     * BinaryBotPrivateTickAnalysisIfDataAvailable) BEFORE the tick analysis runs, so
     * an epoch whose data has left the available Deriv history window is never
     * evaluated - not even its tick-analysis blocks - against another epoch's data.
     *
     * The condition is accounted as `unavailable` (never as `processed`), reported
     * once per engine, and puts the engine into the terminal FAST integrity-failure
     * safe-stop (getTickStreamStats().failed === true). If the epoch has not been
     * popped yet it stays `pending`: it is accounted when it is popped, where the
     * guard is consulted again.
     *
     * Always false in NORMAL mode (NORMAL never calls this).
     */
    isTickDataUnavailable() {
        const stream = getFastTickStream(this);
        const view_epoch = getViewEpoch(stream);

        if (view_epoch === null || view_epoch === undefined) return false;
        if (stream.processing_unavailable) return true;

        const tick_list = this.$scope?.ticksService?.ticks?.get?.(this.symbol);

        // No data to judge with: never claim "unavailable" without evidence. The
        // tick-data view (Ticks.trimToProcessingEpoch) is the second line of defence.
        if (!tick_list || !tick_list.length) return false;
        if (isEpochInTickList(tick_list, view_epoch)) return false;

        markTickDataUnavailable(this, view_epoch, tick_list[0].epoch);

        return true;
    }

    /**
     * FAST: called by the tick-data view when the epoch's own data was served.
     * Returns true when this call accounted the epoch (at most once per epoch).
     */
    markTickDataServed(epoch) {
        return markTickDataServed(this, epoch);
    }

    /**
     * FAST: called by the tick-data view when the epoch's own data is no longer
     * available. Returns true when this call accounted the epoch. This also enters
     * the terminal integrity-failure / safe-stop state (see getTickStreamStats).
     */
    markTickDataUnavailable(epoch, oldest_available_epoch) {
        return markTickDataUnavailable(this, epoch, oldest_available_epoch);
    }

    /**
     * FAST: drops pending ticks. Called on stop / teardown so a stopped session can
     * never replay queued epochs after it has been torn down.
     *
     * The discarded epochs are recorded in `dropped` (terminal disposition) instead
     * of vanishing, so the accounting invariant keeps holding across a Stop. A prior
     * integrity failure is preserved (`failed` / `integrity_failure` are NOT erased)
     * so a failed FAST run stays distinguishable from a normal Stop/teardown.
     */
    resetTickStream() {
        clearFastTickStream(this);
    }

    /**
     * FAST: per-engine tick stream counters — THE authoritative acceptance metric.
     *
     *   received = processed + pending + dropped + unavailable
     *
     *   received    - unique live tick epochs recorded for this engine
     *   processed   - epochs whose OWN tick data was served to the interpreter
     *                 (exactly once, in FIFO order)
     *   pending     - epochs waiting in the FIFO + the epoch in flight right now
     *   dropped     - terminal discards (Stop/teardown, aborted iterations)
     *   unavailable - TERMINAL INTEGRITY-FAILURE MARKER: epochs that could not be
     *                 evaluated with their own data because it had left the history
     *                 window (reported, never substituted, never processed)
     *
     * `failed` / `integrity_failure` make that terminal state explicit: `failed` is
     * true once the engine stopped safely, and `integrity_failure` records the
     * affected epoch, the oldest available epoch and the backlog that was left
     * unprocessed (kept as `pending`, never converted into successful processing).
     *
     * A successfully completed run therefore satisfies received === processed with
     * dropped === 0, unavailable === 0 and failed === false. Unlike the page-wide
     * `tickStreamStats` (diagnostic only), these counters belong to one engine and
     * one session.
     */
    getTickStreamStats() {
        const stream = getFastTickStream(this);

        return {
            received: stream.received,
            processed: stream.processed,
            pending: stream.queue.length + countInFlight(stream),
            processing: stream.processing,
            processing_resolved: stream.processing_resolved,
            processing_unavailable: stream.processing_unavailable,
            max_pending: stream.max_pending,
            dropped: stream.dropped,
            unavailable: stream.unavailable,
            backlog_reports: stream.backlog_reports,
            unavailable_reports: stream.unavailable_reports,
            failed: stream.failed,
            integrity_failure: stream.integrity_failure,
        };
    }

    makeDirectPurchaseDecision() {
        // Deriv's new trading API (api.derivws.com) no longer accepts `symbol`
        // inside the `buy` `parameters` object — it returns:
        //   InputValidationFailed: "Properties not allowed: symbol"
        // The only valid buy format on this endpoint is:
        //   { buy: <proposal_id>, price: <ask_price> }
        // which requires a prior proposal subscription to obtain the proposal ID.
        //
        // We therefore always use the proposal-subscription path regardless of
        // whether the bot XML contains a payout block.  The previous "direct buy"
        // shortcut is disabled until/unless Deriv adds the parameter back.
        this.is_proposal_subscription_required = true;
        this.makeProposals({ ...this.options, ...this.tradeOptions });
        this.checkProposalReady();
    }
}
