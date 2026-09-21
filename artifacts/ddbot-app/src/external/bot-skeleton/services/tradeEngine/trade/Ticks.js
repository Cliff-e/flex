/* eslint-disable no-promise-executor-return */
import debounce from 'lodash.debounce';
import { localize } from '@deriv-com/translations';
import { getLast } from '../../../utils/binary-utils';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { getDirection, getLastDigit, stripNullish } from '../utils/helpers';
import { expectPositiveInteger } from '../utils/sanitize';
import { executionMode } from '../utils/execution-mode';
import * as constants from './state/constants';

let tickListenerKey;
// FAST mode: per-epoch memo for the tick-list API (readFastTicksMemo no-ops in NORMAL).
//
// getTicks() rebuilds a list of up to 1000 entries and the interpreter then copies
// the whole array into its own heap on every single call, which is the largest
// per-tick CPU cost of the tick APIs. The immutable tick list that ticks_service
// keeps per symbol is a safe cache key: it is replaced exactly once per accepted
// tick, and duplicate/replayed epochs return the same reference.
//
// Safety rules:
//   - a value is only written when the list it was built from is still the stored
//     list, so a newer tick can never be served an older list;
//   - the cached array is never mutated (the interpreter copies it), so sharing it
//     is safe;
//   - NORMAL mode never reads or writes the cache.
let fastTicksMemo = new WeakMap();

const readFastTicksMemo = (engine, value_key) => {
    if (!executionMode.isFast()) return undefined;

    const memo = fastTicksMemo.get(engine);
    if (!memo || memo.value_key !== value_key) return undefined;
    if (memo.source !== engine.$scope.ticksService.ticks.get(engine.symbol)) return undefined;

    return memo.value;
};

const writeFastTicksMemo = (engine, source, value_key, value) => {
    if (!executionMode.isFast()) return;

    fastTicksMemo.set(engine, { source, value_key, value });
};

// FAST mode: tick data view for the epoch the interpreter must see right now.
//
// A queued tick must be evaluated against ITS OWN tick data, not against the
// newest tick: otherwise a queued Tick 2 would be measured with Tick 4 data (or be
// deduped away by the generated epoch check) and FAST would silently lose it.
//
// The view is trimmed to `epoch <= view_epoch`, where view_epoch is the epoch being
// processed or - while epochs are still queued - the FIFO HEAD (see
// TradeEngine.getProcessingTickEpoch). A tick-data read performed outside the FIFO
// can therefore never jump ahead of the queue.
//
// If the requested epoch is older than everything still available (its data has
// left the Deriv history window) the view is trimmed to the OLDEST available entry
// - NEVER to the newest live tick - and the epoch is reported as unavailable
// (engine.markTickDataUnavailable) so it is never counted as "evaluated with its
// own data". That call also puts FAST into its terminal integrity-failure /
// safe-stop state, so no later queued epoch is evaluated either.
//
// While nothing is queued the live list is returned untouched, which is exactly the
// NORMAL behaviour (and NORMAL never enters any of these FAST branches).
//
// `track_epoch_data` is true for TICK-list reads (the reads the tick analysis uses)
// and false for candle/OHLC reads, so a candle window can never mark a tick epoch
// as served or unavailable.
const findLastIndexAtOrBefore = (list, epoch) => {
    let low = 0;
    let high = list.length - 1;
    let found = -1;

    while (low <= high) {
        // eslint-disable-next-line no-bitwise
        const mid = (low + high) >> 1;

        if (list[mid].epoch <= epoch) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return found;
};

/**
 * True when `epoch` is still inside the available tick list, i.e. when its own data
 * can be served.
 *
 * Exported for the engine's FAST availability guard: the generated FAST loop asks
 * the engine whether the epoch it is about to evaluate still has its own tick data
 * BEFORE it runs the tick analysis, so an epoch whose data has left the Deriv
 * history window is never evaluated against another epoch's data.
 */
export const isEpochInTickList = (list, epoch) =>
    Boolean(list && list.length) && findLastIndexAtOrBefore(list, epoch) >= 0;

const trimToProcessingEpoch = (engine, list, track_epoch_data = false) => {
    if (!executionMode.isFast()) return list;
    if (!list || !list.length) return list;

    const processing_epoch = engine.getProcessingTickEpoch ? engine.getProcessingTickEpoch() : null;
    if (processing_epoch === null || processing_epoch === undefined) return list;

    const last_index = findLastIndexAtOrBefore(list, processing_epoch);

    if (last_index < 0) {
        // Cannot evaluate this exact epoch: its own data is gone. Accounting is
        // explicit (never "processed"), the exposed window is the oldest one
        // available - never the newest live tick - and the engine enters its
        // terminal integrity-failure / safe-stop state so nothing else is evaluated.
        if (track_epoch_data && engine.markTickDataUnavailable) {
            engine.markTickDataUnavailable(processing_epoch, list[0].epoch);
        }

        return list.slice(0, 1);
    }

    // The epoch's own data was resolved and is being handed to the interpreter.
    if (track_epoch_data && engine.markTickDataServed) {
        engine.markTickDataServed(processing_epoch);
    }

    if (last_index === list.length - 1) return list;

    return list.slice(0, last_index + 1);
};

const getFastTicksMemoKey = (engine, value_key) => {
    const processing_epoch = engine.getProcessingTickEpoch ? engine.getProcessingTickEpoch() : null;

    return value_key + '|' + (processing_epoch === null || processing_epoch === undefined ? '' : processing_epoch);
};

export default Engine =>
    class Ticks extends Engine {
        async watchTicks(symbol) {
            if (symbol && this.symbol !== symbol) {
                this.symbol = symbol;
                const { ticksService } = this.$scope;

                await ticksService.stopMonitor({
                    symbol,
                    key: tickListenerKey,
                });
                const callback = ticks => {
                    if (this.is_proposal_subscription_required) {
                        this.checkProposalReady();
                    }
                    const lastTick = ticks.slice(-1)[0];
                    const { epoch } = lastTick;
                    // FAST: queue the epoch BEFORE the NEW_TICK dispatch can resolve any
                    // watch, so a tick is never observed by the interpreter without first
                    // being recorded. NORMAL does not record anything (its path is
                    // unchanged).
                    this.recordTickEpoch(epoch);
                    this.store.dispatch({ type: constants.NEW_TICK, payload: epoch });
                };

                const key = await ticksService.monitor({ symbol, callback });
                tickListenerKey = key;
            }
        }

        checkTicksPromiseExists() {
            return this.$scope.ticksService.ticks_history_promise;
        }

        getTicks(toString = false) {
            const memo_key = executionMode.isFast() ? getFastTicksMemoKey(this, toString) : null;

            if (memo_key) {
                // Per-tick memo: recomputed only when a new tick (or a new backlog cursor)
                // actually arrived.
                const cached = readFastTicksMemo(this, memo_key);
                if (cached !== undefined) return Promise.resolve(cached);
            }

            return new Promise(resolve => {
                this.$scope.ticksService.request({ symbol: this.symbol }).then(ticks => {
                    // FAST: trim to the epoch being evaluated (no-op while not backlogged).
                    const view = trimToProcessingEpoch(this, ticks, true);

                    const ticks_list = view.map(tick => {
                        if (toString) {
                            return tick.quote.toFixed(this.getPipSize());
                        }
                        return tick.quote;
                    });

                    if (memo_key) {
                        // Write only when the list this value was built from is still the
                        // stored list, otherwise skip the cache (never serve stale data).
                        if (this.$scope.ticksService.ticks.get(this.symbol) === ticks) {
                            writeFastTicksMemo(this, ticks, memo_key, ticks_list);
                        }
                    }

                    resolve(ticks_list);
                });
            });
        }

        getLastTick(raw, toString = false) {
            return new Promise(resolve =>
                this.$scope.ticksService
                    .request({ symbol: this.symbol })
                    .then(ticks => {
                        const view = trimToProcessingEpoch(this, ticks, true);
                        let last_tick = raw ? getLast(view) : getLast(view).quote;
                        if (!raw && toString) {
                            last_tick = last_tick.toFixed(this.getPipSize());
                        }
                        resolve(last_tick);
                    })
                    .catch(e => {
                        if (e.code === 'MarketIsClosed') {
                            globalObserver.emit('Error', e);
                            resolve(e.code);
                        }
                    })
            );
        }

        getLastDigit() {
            return new Promise(resolve => this.getLastTick(false, true).then(tick => resolve(getLastDigit(tick))));
        }

        getLastDigitList() {
            return new Promise(resolve => this.getTicks().then(ticks => resolve(this.getLastDigitsFromList(ticks))));
        }
        getLastDigitsFromList(ticks) {
            const digits = ticks.map(tick => {
                return getLastDigit(tick.toFixed(this.getPipSize()));
            });
            return digits;
        }

        checkDirection(dir) {
            return new Promise(resolve =>
                this.$scope.ticksService
                    .request({ symbol: this.symbol })
                    .then(ticks => resolve(getDirection(trimToProcessingEpoch(this, ticks, true)) === dir))
            );
        }

        getOhlc(args) {
            const { granularity = this.options.candleInterval || 60, field } = args || {};

            return new Promise(resolve =>
                this.$scope.ticksService
                    .request({ symbol: this.symbol, granularity })
                    .then(ohlc => resolve(field ? trimToProcessingEpoch(this, ohlc).map(o => o[field]) : trimToProcessingEpoch(this, ohlc)))
            );
        }

        getOhlcFromEnd(args) {
            const { index: i = 1 } = args || {};

            const index = expectPositiveInteger(Number(i), localize('Index must be a positive integer'));

            return new Promise(resolve => this.getOhlc(args).then(ohlc => resolve(ohlc.slice(-index)[0])));
        }

        getPipSize() {
            return this.$scope.ticksService.pipSizes[this.symbol];
        }

        async requestAccumulatorStats() {
            const subscription_id = this.subscription_id_for_accumulators;
            const is_proposal_requested = this.is_proposal_requested_for_accumulators;
            // This proposal payload is built independently from tradeOptionToProposal()
            // (helpers.js), so it must go through the same nullish-stripping — otherwise
            // it can carry `amount`/`growth_rate`/etc. as explicit `undefined` keys and
            // get rejected by Deriv with "Input validation failed: parameters".
            const proposal_request = stripNullish({
                ...window.Blockly.accumulators_request,
                amount: this?.tradeOptions?.amount,
                basis: this?.tradeOptions?.basis,
                contract_type: 'ACCU',
                currency: this?.tradeOptions?.currency,
                growth_rate: this?.tradeOptions?.growth_rate,
                proposal: 1,
                subscribe: 1,
                symbol: this?.tradeOptions?.symbol,
            });
            if (!subscription_id && !is_proposal_requested) {
                this.is_proposal_requested_for_accumulators = true;
                if (proposal_request) {
                    console.log('[TRADE][AccumulatorProposal] Sending proposal request:', proposal_request);
                    try {
                        const response = await api_base?.api?.send(proposal_request);
                        console.log('[TRADE][AccumulatorProposal] Proposal response:', response);
                    } catch (error) {
                        console.error('[TRADE][AccumulatorProposal] Proposal request failed', {
                            request: proposal_request,
                            response: error,
                            errorCode: error?.error?.code,
                            errorMessage: error?.error?.message,
                            errorDetails: error?.error?.details,
                        });
                        throw error;
                    }
                }
            }
        }

        async handleOnMessageForAccumulators() {
            let ticks_stayed_in_list = [];
            return new Promise(resolve => {
                const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                    if (data.msg_type === 'proposal') {
                        try {
                            this.subscription_id_for_accumulators = data.subscription.id;
                            // this was done because we can multile arrays in the respone and the list comes in reverse order
                            const stat_list = (data.proposal.contract_details.ticks_stayed_in || []).flat().reverse();
                            ticks_stayed_in_list = [...stat_list, ...ticks_stayed_in_list];
                            if (ticks_stayed_in_list.length > 0) resolve(ticks_stayed_in_list);
                        } catch (error) {
                            globalObserver.emit('Unexpected message type or no proposal found:', error);
                        }
                    }
                });
                api_base.pushSubscription(subscription);
            });
        }

        async fetchStatsForAccumulators() {
            try {
                // request stats for accumulators
                const debouncedAccumulatorsRequest = debounce(() => this.requestAccumulatorStats(), 300);
                debouncedAccumulatorsRequest();
                // wait for proposal response
                const ticks_stayed_in_list = await this.handleOnMessageForAccumulators();
                return ticks_stayed_in_list;
            } catch (error) {
                globalObserver.emit('Error in subscription promise:', error);
                throw error;
            } finally {
                // forget all proposal subscriptions so we can fetch new stats data on new call
                await api_base?.api?.send({ forget_all: 'proposal' });
                this.is_proposal_requested_for_accumulators = false;
                this.subscription_id_for_accumulators = null;
            }
        }

        async getCurrentStat() {
            try {
                const ticks_stayed_in = await this.fetchStatsForAccumulators();
                return ticks_stayed_in?.[0];
            } catch (error) {
                globalObserver.emit('Error fetching current stat:', error);
            }
        }

        async getStatList() {
            try {
                const ticks_stayed_in = await this.fetchStatsForAccumulators();
                // we need to send only lastest 100 ticks
                return ticks_stayed_in?.slice(0, 100);
            } catch (error) {
                globalObserver.emit('Error fetching current stat:', error);
            }
        }

        async getDelayTickValue(tick_value) {
            return new Promise((resolve, reject) => {
                try {
                    const ticks = [];
                    const symbol = this.symbol;

                    const resolveAndExit = () => {
                        this.$scope.ticksService.stopMonitor({
                            symbol,
                            key: '',
                        });
                        resolve(ticks);
                        ticks.length = 0;
                    };

                    const watchTicks = tick_list => {
                        ticks.push(tick_list);
                        const current_tick = ticks.length;
                        if (current_tick === tick_value) {
                            resolveAndExit();
                        }
                    };

                    const delayExecution = tick_list => watchTicks(tick_list);

                    if (Number(tick_value) <= 0) resolveAndExit();
                    this.$scope.ticksService.monitor({ symbol, callback: delayExecution });
                } catch (error) {
                    reject(new Error(`Failed to start tick monitoring: ${error.message}`));
                }
            });
        }
    };
