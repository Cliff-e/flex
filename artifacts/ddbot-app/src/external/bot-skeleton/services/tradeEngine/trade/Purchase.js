import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { VirtualHookRuntime } from '../runtime/VirtualHookRuntime';
import { openContractReceived, purchaseSuccessful, sell } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

/**
 * Maps each contract type to its direct opposite.
 * Both directions are listed so lookups work regardless of which side is active.
 * This is the single source of truth — hedge() and _applyActiveOverrides() both
 * read from here and nowhere else.
 *
 * Exported so ActiveContract can import it to widen proposals when an override
 * is active (ensures the opposite type's proposal is always available for hedge).
 */
export const OPPOSITE_CONTRACT_MAP = {
    CALL:        'PUT',
    PUT:         'CALL',
    CALLE:       'PUTE',
    PUTE:        'CALLE',
    ONETOUCH:    'NOTOUCH',
    NOTOUCH:     'ONETOUCH',
    EXPIRYRANGE: 'EXPIRYMISS',
    EXPIRYMISS:  'EXPIRYRANGE',
    DIGITMATCH:  'DIGITDIFF',
    DIGITDIFF:   'DIGITMATCH',
    DIGITEVEN:   'DIGITODD',
    DIGITODD:    'DIGITEVEN',
    DIGITOVER:   'DIGITUNDER',
    DIGITUNDER:  'DIGITOVER',
    RESETCALL:   'RESETPUT',
    RESETPUT:    'RESETCALL',
    RUNHIGH:     'RUNLOW',
    RUNLOW:      'RUNHIGH',
    CALLSPREAD:  'PUTSPREAD',
    PUTSPREAD:   'CALLSPREAD',
    ASIANU:      'ASIAND',
    ASIAND:      'ASIANU',
};

export default Engine =>
    class Purchase extends Engine {
        /**
         * Explicit in-progress guard.  Set to true between the synchronous entry
         * of purchase() and the moment purchaseSuccessful() is dispatched.  Cleared
         * in onSuccess (real trades), after purchaseSuccessful() dispatch (virtual
         * trades), and in every recoverFn callback before a REVERT.
         *
         * This closes the window where the scope-based guard cannot help: the scope
         * only transitions to DURING_PURCHASE after the async API buy response, so
         * without this flag a second purchase/hedge call issued before the response
         * arrives would pass the scope check and send a duplicate buy request.
         */
        _purchaseInProgress = false;

        purchase(contract_type) {
            // Prevent calling purchase twice — scope-based guard (async).
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            // Prevent duplicate buy requests while the first is still pending
            // (synchronous guard that covers the API round-trip window).
            if (this._purchaseInProgress) {
                return Promise.resolve();
            }
            this._purchaseInProgress = true;

            // eslint-disable-next-line no-console
            console.log(
                `[VH] Purchase.purchase() ENTER | scope=${this.store.getState().scope}` +
                ` | isVirtualMode=${this.virtualHookRuntime.isVirtualMode()}` +
                ` | contract_type=${contract_type}`
            );

            // Resolve the effective contract type.
            //
            // 'DISABLE' from the Purchase block dropdown means "do not override —
            // use whatever is currently active".  Precedence for DISABLE:
            //   1. activeContractOverride (set by Contract Changer block)
            //   2. Trade Parameters contractTypes[0]
            //
            // Any real contract type selected in the Purchase block takes precedence
            // over everything, including activeContractOverride — the block's explicit
            // choice is the highest-priority signal for that single purchase.
            const effective_type =
                contract_type === 'DISABLE'
                    ? (this.activeContractOverride ?? this.tradeOptions?.contractTypes?.[0] ?? null)
                    : contract_type;

            // ── Virtual Hook intercept ─────────────────────────────────────────
            // When the hook is in virtual mode, run tick-based simulations rather
            // than placing a real trade.  Each simulation waits for a live market
            // tick, samples the last digit, and calls determineOutcome() to derive
            // a win/loss without any API buy.  Once the configured sequence is
            // complete, isVirtualMode() returns false and we fall through to the
            // real purchase below.
            //
            // _executeVirtualTrade is referenced in the hedge() comment because
            // activeContractOverride is read synchronously at the top of both this
            // method and _executeVirtualTrade — the comment is therefore correct
            // once this implementation exists.
            // ── Virtual Hook pre-trade filter ─────────────────────────────────
            // When VH is enabled, observe live market ticks and count virtual
            // outcomes before deciding whether to place a real trade.
            //
            // PROCEED  → real trade is allowed; fall through to the buy path.
            // DISCARD  → conditions not met within max steps; drop this signal.
            //
            // The real purchase (if allowed) uses the stake already determined
            // by the trading engine — vh_stake never modifies real trade sizing.
            if (this.virtualHookRuntime.isEnabled()) {
                return this._runVirtualFilter(effective_type).then(allowed => {
                    this._purchaseInProgress = false;
                    if (!allowed) {
                        // Signal discarded — VH conditions were not met.
                        // Do NOT place any real trade for this signal.
                        // eslint-disable-next-line no-console
                        console.log('[VH] Signal DISCARDED — real trade skipped. Waiting for next signal.');
                        return Promise.resolve();
                    }
                    // Signal approved — proceed to real purchase.
                    // eslint-disable-next-line no-console
                    console.log('[VH] Signal APPROVED — executing real trade.');
                    return this.purchase(contract_type);
                });
            }

            const onSuccess = response => {
                // Buy acknowledged — scope transitions to DURING_PURCHASE via
                // purchaseSuccessful(); the scope guard takes over from here.
                this._purchaseInProgress = false;

                const { buy } = response;

                // eslint-disable-next-line no-console
                console.log(
                    `[VH] Buy response received | contract_id=${buy.contract_id}` +
                    ` | transaction_id=${buy.transaction_id}` +
                    ` | isVirtualMode=${this.virtualHookRuntime.isVirtualMode()}`
                );

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.store.dispatch(purchaseSuccessful());

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { longcode: buy.longcode, transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type: effective_type,
                    buy_price: buy.buy_price,
                });
            };

            if (this.is_proposal_subscription_required) {
                const { id, askPrice } = this.selectProposal(effective_type);

                const action = () => {
                    const buy_request = { buy: id, price: askPrice };
                    // eslint-disable-next-line no-console
                    console.log('[TRADE][Purchase] Sending buy request:', JSON.stringify(buy_request));
                    return api_base.api
                        .send(buy_request)
                        .then(response => {
                            // eslint-disable-next-line no-console
                            console.log('[TRADE][Purchase] Buy response:', JSON.stringify(response));
                            return response;
                        })
                        .catch(error => {
                            console.error(
                                '[TRADE][Purchase] Buy request failed',
                                JSON.stringify({
                                    request: buy_request,
                                    response: error,
                                    errorCode: error?.error?.code,
                                    errorMessage: error?.error?.message,
                                    errorDetails: error?.error?.details,
                                })
                            );
                            throw error;
                        });
                };

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        // Clear the in-progress guard before REVERT so the
                        // before_purchase retry can call purchase() again.
                        this._purchaseInProgress = false;

                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }

            const trade_option = tradeOptionToBuy(effective_type, this.tradeOptions);
            const action = () => {
                // eslint-disable-next-line no-console
                console.log('[TRADE][Purchase] Sending direct buy request:', JSON.stringify(trade_option));
                return api_base.api
                    .send(trade_option)
                    .then(response => {
                        // eslint-disable-next-line no-console
                        console.log('[TRADE][Purchase] Direct buy response:', JSON.stringify(response));
                        return response;
                    })
                    .catch(error => {
                        console.error(
                            '[TRADE][Purchase] Direct buy request failed',
                            JSON.stringify({
                                request: trade_option,
                                response: error,
                                errorCode: error?.error?.code,
                                errorMessage: error?.error?.message,
                                errorDetails: error?.error?.details,
                            })
                        );
                        throw error;
                    });
            };

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    // Clear the in-progress guard before REVERT so the
                    // before_purchase retry can call purchase() again.
                    this._purchaseInProgress = false;

                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }

        /**
         * Execute a hedge trade by purchasing the opposite of the currently
         * active contract type.
         *
         * Design principle: zero duplicated execution logic.
         * This method only resolves the opposite contract type then delegates
         * straight into the existing purchase() pipeline, which handles:
         *   • proposal subscription & selection (selectProposal)
         *   • buy request + retry (doUntilDone / recoverFromError)
         *   • open contract monitoring (renewProposalsOnPurchase)
         *   • recovery engine (timeMachineEnabled path)
         *
         * The activeContractOverride is temporarily cleared for the duration of
         * the purchase() call so that purchase() does not re-apply the override
         * on top of the already-resolved opposite type.  It is restored
         * synchronously before any async work begins.
         *
         * @returns {Promise<void>}
         */
        hedge() {
            // Determine the currently effective contract type.
            const current_type = this.activeContractOverride || this.tradeOptions?.contractTypes?.[0];

            if (!current_type) {
                // eslint-disable-next-line no-console
                console.error('[TRADE][Hedge] Cannot determine current contract type — no active override or trade option set.');
                return Promise.resolve();
            }

            const opposite_type = OPPOSITE_CONTRACT_MAP[current_type];

            if (!opposite_type) {
                // eslint-disable-next-line no-console
                console.error(`[TRADE][Hedge] No opposite contract type defined for "${current_type}".`);
                return Promise.resolve();
            }

            // eslint-disable-next-line no-console
            console.log(`[TRADE][Hedge] ${current_type} → ${opposite_type}`);

            // Temporarily clear the override so purchase() uses opposite_type as-is.
            // activeContractOverride is only read synchronously at the top of purchase()
            // and _executeVirtualTrade(), so restoring it before the await is safe.
            const saved_override = this.activeContractOverride;
            this.activeContractOverride = null;
            const result = this.purchase(opposite_type);
            this.activeContractOverride = saved_override;

            return result;
        }

        /**
         * Execute the same contract type N times in one before_purchase phase.
         *
         * Design constraints:
         *   • The scope guard (BEFORE_PURCHASE) is checked once at entry — it is
         *     never bypassed or weakened.
         *   • The _purchaseInProgress flag is held for the entire batch so no
         *     concurrent purchase() or hedge() call can slip in between buys.
         *   • purchaseSuccessful() (which transitions scope → DURING_PURCHASE) is
         *     dispatched only after the final buy in the batch.
         *   • The effective contract type is resolved once from the priority chain
         *     (explicit type > activeContractOverride > Trade Parameters).
         *   • Between intermediate buys, renewProposalsOnPurchase() is called and
         *     this method waits for proposalsReady before selecting the next proposal.
         *   • When count === 1 the method delegates to the standard purchase() path
         *     so non-bulk bots are completely unaffected.
         *
         * @param {string} contract_type  - Raw value from the Blockly dropdown
         *                                  (e.g. 'CALL', 'PUT', 'DISABLE').
         * @param {number} count          - Number of contracts to buy (≥ 1).
         * @returns {Promise<void>}
         */
        async purchaseMultiple(contract_type, count) {
            const totalBuys = Math.max(1, Math.floor(count) || 1);

            // Single-buy: delegate entirely to the standard purchase() pipeline
            // (timeMachineEnabled / recoverFromError support is preserved).
            if (totalBuys === 1) {
                return this.purchase(contract_type);
            }

            // ── Guards (same semantics as purchase()) ──────────────────────────
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return;
            }
            if (this._purchaseInProgress) {
                return;
            }
            this._purchaseInProgress = true;

            // ── Resolve effective contract type once ───────────────────────────
            const effective_type =
                contract_type === 'DISABLE'
                    ? (this.activeContractOverride ?? this.tradeOptions?.contractTypes?.[0] ?? null)
                    : contract_type;

            // eslint-disable-next-line no-console
            console.log(
                `[VH] Purchase.purchaseMultiple() ENTER | count=${totalBuys}` +
                ` | effective_type=${effective_type}` +
                ` | scope=${this.store.getState().scope}`
            );

            /**
             * Resolves once store.proposalsReady is true.
             * Used between intermediate bulk buys to ensure a fresh proposal is
             * available before the next selectProposal() call.
             */
            const waitForProposals = () =>
                new Promise(resolve => {
                    if (this.store.getState().proposalsReady) { resolve(); return; }
                    const unsub = this.store.subscribe(() => {
                        if (this.store.getState().proposalsReady) { unsub(); resolve(); }
                    });
                });

            // ── Batch loop ─────────────────────────────────────────────────────
            for (let i = 0; i < totalBuys; i++) {
                const isLast = i === totalBuys - 1;

                if (this.is_proposal_subscription_required) {
                    const { id, askPrice } = this.selectProposal(effective_type);

                    this.isSold = false;
                    contractStatus({ id: 'contract.purchase_sent', data: askPrice });

                    // eslint-disable-next-line no-await-in-loop
                    const response = await doUntilDone(() =>
                        api_base.api.send({ buy: id, price: askPrice })
                    );
                    const { buy } = response;

                    contractStatus({ id: 'contract.purchase_received', data: buy.transaction_id, buy });
                    this.contractId = buy.contract_id;
                    log(LogTypes.PURCHASE, { longcode: buy.longcode, transaction_id: buy.transaction_id });
                    info({
                        accountID: this.accountInfo.loginid,
                        totalRuns: this.updateAndReturnTotalRuns(),
                        transaction_ids: { buy: buy.transaction_id },
                        contract_type: effective_type,
                        buy_price: buy.buy_price,
                    });

                    if (isLast) {
                        this._purchaseInProgress = false;
                        delayIndex = 0;
                        this.store.dispatch(purchaseSuccessful());
                        this.renewProposalsOnPurchase();
                    } else {
                        // Renew subscriptions and wait for fresh proposals before
                        // the next selectProposal() call in the loop.
                        this.renewProposalsOnPurchase();
                        // eslint-disable-next-line no-await-in-loop
                        await waitForProposals();
                    }
                } else {
                    const trade_option = tradeOptionToBuy(effective_type, this.tradeOptions);

                    this.isSold = false;
                    contractStatus({ id: 'contract.purchase_sent', data: this.tradeOptions.amount });

                    // eslint-disable-next-line no-await-in-loop
                    const response = await doUntilDone(() =>
                        api_base.api.send(trade_option)
                    );
                    const { buy } = response;

                    contractStatus({ id: 'contract.purchase_received', data: buy.transaction_id, buy });
                    this.contractId = buy.contract_id;
                    log(LogTypes.PURCHASE, { longcode: buy.longcode, transaction_id: buy.transaction_id });
                    info({
                        accountID: this.accountInfo.loginid,
                        totalRuns: this.updateAndReturnTotalRuns(),
                        transaction_ids: { buy: buy.transaction_id },
                        contract_type: effective_type,
                        buy_price: buy.buy_price,
                    });

                    if (isLast) {
                        this._purchaseInProgress = false;
                        delayIndex = 0;
                        this.store.dispatch(purchaseSuccessful());
                    }
                }
            }
        }

        // ── Virtual Hook implementation ────────────────────────────────────────

        /**
         * Wait for the next market tick.
         * Used between virtual trade rounds so each round samples a distinct
         * tick rather than re-reading the same last digit in a tight loop.
         *
         * @returns {Promise<void>}
         */
        _waitForNextTick() {
            return new Promise(resolve => {
                const currentTick = this.store.getState().newTick;
                const unsub = this.store.subscribe(() => {
                    if (this.store.getState().newTick !== currentTick) {
                        unsub();
                        resolve();
                    }
                });
            });
        }

        /**
         * Pre-trade filter — evaluates live market ticks to decide whether a
         * real trade should be placed or discarded.
         *
         * Flow per signal:
         *   1. startSignal() resets per-signal counters.
         *   2. For each live tick:
         *        a. Wait for a distinct tick.
         *        b. Simulate the contract outcome (no API buy — zero real money).
         *        c. Call recordTick(won) → PROCEED | DISCARD | CONTINUE.
         *   3. Return true  (PROCEED) → caller executes the real trade.
         *      Return false (DISCARD) → caller drops this signal entirely.
         *
         * The real purchase that follows uses the stake already determined by the
         * trading engine.  vh_stake never influences real trade sizing.
         *
         * @param {string} contract_type  Effective contract type (already resolved).
         * @returns {Promise<boolean>}    true = execute real trade, false = drop signal.
         */
        async _runVirtualFilter(contract_type) {
            this.virtualHookRuntime.startSignal();
            // eslint-disable-next-line no-console
            console.log(
                `[VH] _runVirtualFilter() START | contractType=${contract_type}` +
                ` | maxSteps=${this.virtualHookRuntime.maxSteps}` +
                ` | minWins=${this.virtualHookRuntime.minWins}`
            );

            let step = 0;
            // eslint-disable-next-line no-constant-condition
            for (;;) {
                // Wait for a distinct market tick before sampling.
                // eslint-disable-next-line no-await-in-loop
                await this._waitForNextTick();

                // Sample the last digit of the current tick price.
                // getLastDigit() is provided by the Ticks mixin in the class chain.
                // eslint-disable-next-line no-await-in-loop
                const lastDigit = await this.getLastDigit();

                // Resolve the active prediction (same priority as real trades).
                const prediction =
                    this.activePredictionOverride !== null &&
                    this.activePredictionOverride !== undefined
                        ? this.activePredictionOverride
                        : (this.tradeOptions?.prediction ?? null);

                // Simulate the contract outcome — pure tick-based, no API call.
                const won = VirtualHookRuntime.determineOutcome(contract_type, lastDigit, prediction);

                step++;
                const result = this.virtualHookRuntime.recordTick(won);

                // eslint-disable-next-line no-console
                console.log(
                    `[VH] Step ${step}/${this.virtualHookRuntime.maxSteps}` +
                    ` | contractType=${contract_type}` +
                    ` | lastDigit=${lastDigit}` +
                    ` | prediction=${prediction}` +
                    ` | won=${won}` +
                    ` | result=${result}`
                );

                if (result === 'PROCEED') {
                    // eslint-disable-next-line no-console
                    console.log(`[VH] PROCEED after ${step} steps — real trade authorized.`);
                    return true;
                }
                if (result === 'DISCARD') {
                    // eslint-disable-next-line no-console
                    console.log(`[VH] DISCARD after ${step} steps — signal dropped.`);
                    return false;
                }
                // 'CONTINUE' — keep observing
            }
        }

        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
