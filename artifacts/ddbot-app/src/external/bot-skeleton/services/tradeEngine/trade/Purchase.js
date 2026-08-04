import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy, tradeOptionToProposal } from '../utils/helpers';
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
                `[BUY TRACE] Purchase.purchase ENTER | scope=${this.store.getState().scope}` +
                ` | contract_type=${contract_type}` +
                ` | vhEnabled=${this.virtualHookRuntime.isEnabled()}` +
                ` | vhAuthorizedOnce=${!!this._vhAuthorizedOnce}`
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

            // ── Virtual Hook pre-trade filter ─────────────────────────────────
            // When VH is enabled, observe live market ticks and count virtual
            // outcomes before deciding whether to place a real trade.
            //
            // PROCEED  → set _vhAuthorizedOnce=true and re-call purchase().
            //            The re-entrant call sees the flag, clears it, and skips
            //            VH to execute the real buy.  Without this flag the
            //            re-entry loops forever because isEnabled() stays true.
            // DISCARD  → return without placing any trade.
            //
            // The real purchase uses the stake already determined by the trading
            // engine — vh_stake never modifies real trade sizing.
            if (this.virtualHookRuntime.isEnabled() && !this._vhAuthorizedOnce) {
                // ── VH: snapshot proposal state before evaluation ─────────
                // Save the effective contract type and purchase reference that
                // existed when the signal arrived.  During VH evaluation (which
                // spans multiple ticks), overrides may fire and call
                // _rebuildProposals(), invalidating the proposals.  After VH
                // authorises, we use this snapshot to verify — and if necessary
                // rebuild — the correct proposals for the authorised trade.
                const vhContractType = effective_type;
                const vhPurchaseRef  = this.getPurchaseReference();
                // eslint-disable-next-line no-console
                console.log(
                    `[BUY TRACE] VH SNAPSHOT | contractType=${vhContractType}` +
                    ` | purchaseRef=${vhPurchaseRef}` +
                    ` | proposalsCount=${this.data.proposals.length}`
                );

                return this._runVirtualFilter(effective_type)
                    .then(allowed => {
                        this._purchaseInProgress = false;
                        if (!allowed) {
                            // eslint-disable-next-line no-console
                            console.log('[BUY TRACE] EXIT reason=VH_DISCARDED — signal dropped, no trade placed.');
                            return Promise.resolve();
                        }
                        // Set one-shot flag so the re-entrant call bypasses VH and
                        // goes straight to the real buy logic.
                        this._vhAuthorizedOnce = true;

                        // ── VH: validate proposals before re-entering ──────
                        // The purchase_reference may have been regenerated
                        // (by _rebuildProposals) during VH evaluation, or
                        // proposals may have been cleared entirely.  Verify
                        // that a proposal matching the original signal's
                        // contract type exists with the CURRENT reference.
                        // If not, rebuild proposals now so selectProposal()
                        // succeeds in the re-entrant call.
                        const currentRef = this.getPurchaseReference();
                        const hasValidProposal =
                            this.data.proposals.length > 0 &&
                            this.data.proposals.some(
                                p =>
                                    p.contract_type === vhContractType &&
                                    p.purchase_reference === currentRef
                            );

                        // eslint-disable-next-line no-console
                        console.log(
                            `[BUY TRACE] VH PROPOSAL CHECK | vhContractType=${vhContractType}` +
                            ` | vhPurchaseRef=${vhPurchaseRef}` +
                            ` | currentRef=${currentRef}` +
                            ` | refsMatch=${vhPurchaseRef === currentRef}` +
                            ` | hasValidProposal=${hasValidProposal}` +
                            ` | proposalsCount=${this.data.proposals.length}`
                        );

                        if (!hasValidProposal) {
                            // Proposals invalidated during VH evaluation —
                            // rebuild them now and WAIT for proposals to be
                            // ready before the re-entrant call.  _rebuildProposals()
                            // sends async WS requests; the proposals arrive
                            // via observeProposals() which dispatches
                            // proposalsReady() when all templates match.
                            // eslint-disable-next-line no-console
                            console.log(
                                '[BUY TRACE] VH PROPOSAL STALE — rebuilding proposals and awaiting readiness.' +
                                ` | oldRef=${vhPurchaseRef} | newRef=${currentRef}`
                            );
                            this._rebuildProposals();
                            // Wait for the store to signal proposalsReady before
                            // proceeding.  Without this wait, selectProposal()
                            // runs synchronously on an empty proposals array.
                            return this._waitForProposalsReady().then(() => {
                                // eslint-disable-next-line no-console
                                console.log('[BUY TRACE] VH PROPOSAL REBUILT — proposals ready, re-entering purchase().');
                                return this.purchase(contract_type);
                            });
                        }

                        // eslint-disable-next-line no-console
                        console.log('[BUY TRACE] VH APPROVED — re-entering purchase() with bypass flag set.');
                        return this.purchase(contract_type);
                    })
                    .catch(err => {
                        // VH filter failed (e.g. tick service error).
                        this._purchaseInProgress = false;
                        // Hard-reset the runtime so _active can never stay true.
                        // If _active leaked, ActiveContract._rebuildProposals() would
                        // incorrectly defer every subsequent rebuild (VH guard).
                        this.virtualHookRuntime.reset();
                        // eslint-disable-next-line no-console
                        console.error('[BUY TRACE] VH filter error:', err);
                        return Promise.resolve();
                    });
            }

            // Clear the one-shot bypass flag immediately (covers both the VH
            // bypass path above and any non-VH call where the flag was never set).
            this._vhAuthorizedOnce = false;

            // eslint-disable-next-line no-console
            console.log('[BUY TRACE] Guard checks passed — proceeding to proposal/buy.');

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
         * Waits for the store to signal `proposalsReady === true`.
         * Used after _rebuildProposals() to ensure proposals have arrived
         * from the WebSocket before calling selectProposal().
         *
         * @returns {Promise<void>}
         */
        _waitForProposalsReady() {
            return new Promise(resolve => {
                if (this.store.getState().proposalsReady) {
                    resolve();
                    return;
                }
                const unsub = this.store.subscribe(() => {
                    if (this.store.getState().proposalsReady) {
                        unsub();
                        resolve();
                    }
                });
            });
        }

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

        // ── Virtual Hook — contract-based virtual trade executor ──────────────
        // The Virtual Hook now evaluates signals by executing REAL virtual
        // contracts through the same proposal / buy / proposal_open_contract
        // infrastructure used for real trades.  The only difference is that the
        // buy uses vh_stake and the virtual contract's actual settlement
        // outcome feeds the PROCEED/DISCARD state machine.

        /**
         * Build and submit a virtual proposal for a single contract type.
         * Reuses tradeOptionToProposal() + _applyActiveOverrides() so the
         * virtual proposal is priced exactly like a real one, except that the
         * amount is vh_stake.  Uses a virtual-only purchase reference so the
         * virtual proposal can never collide with the real proposal cache.
         *
         * @param {string} contract_type  Effective contract type being evaluated.
         * @returns {Promise<{id: string, askPrice: number}|null>}
         */
        async _submitVirtualProposal(contract_type) {
            if (!this.tradeOptions) {
                console.error('[VH] _submitVirtualProposal() aborted — tradeOptions not set.');
                return null;
            }

            const overridden = this._applyActiveOverrides(this.tradeOptions);
            overridden.contractTypes = [contract_type];
            overridden.amount = this.virtualHookRuntime.stake;

            // Virtual-only purchase reference — guarantees full isolation from
            // the real proposal cache matching in selectProposal()/checkProposalReady().
            const virtual_ref = `VH-${getUUID()}`;
            const [virtual_proposal] = tradeOptionToProposal(overridden, virtual_ref);

            // eslint-disable-next-line no-console
            console.log(
                '[VH] submitVirtualProposal()' +
                ` | contractType=${contract_type}` +
                ` | vhStake=${overridden.amount}` +
                ` | virtualRef=${virtual_ref}`
            );

            try {
                const response = await api_base.api.send(virtual_proposal);
                const proposal_data = response?.proposal ?? response?.data?.proposal;
                if (!proposal_data?.id) {
                    console.error('[VH] Virtual proposal response missing id:', JSON.stringify(response));
                    return null;
                }
                return {
                    id: proposal_data.id,
                    askPrice: proposal_data.ask_price,
                };
            } catch (error) {
                console.error('[VH] Virtual proposal request failed:', JSON.stringify(error));
                return null;
            }
        }

        /**
         * Submit the virtual buy request for an already-priced virtual proposal.
         * Same payload shape as the real buy path ({ buy, price }).
         *
         * @param {string} proposal_id  Proposal id returned by _submitVirtualProposal.
         * @param {number} ask_price    Proposal ask price (reflects vh_stake).
         * @returns {Promise<string|null>}  Virtual contract id, or null on failure.
         */
        async _submitVirtualBuy(proposal_id, ask_price) {
            const buy_request = { buy: proposal_id, price: ask_price };
            // eslint-disable-next-line no-console
            console.log('[VH] submitVirtualBuy() | proposalId=' + proposal_id + ' | price=' + ask_price);

            try {
                const response = await api_base.api.send(buy_request);
                const buy = response?.buy ?? response?.data?.buy;
                if (!buy?.contract_id) {
                    console.error('[VH] Virtual buy response missing contract_id:', JSON.stringify(response));
                    return null;
                }
                // eslint-disable-next-line no-console
                console.log(
                    '[VH] Virtual buy accepted' +
                    ` | contract_id=${buy.contract_id}` +
                    ` | transaction_id=${buy.transaction_id}`
                );
                return buy.contract_id;
            } catch (error) {
                console.error('[VH] Virtual buy request failed:', JSON.stringify(error));
                return null;
            }
        }

        /**
         * Wait for the virtual contract to settle via the shared
         * proposal_open_contract message stream.  The existing OpenContract
         * observer ignores this contract because this.contractId is not set
         * for virtual contracts — so real trade tracking is never disturbed.
         *
         * @param {string}  contract_id  Virtual contract id.
         * @param {number}  timeout_ms   Max time to wait for settlement.
         * @returns {Promise<{won: boolean, timedOut: boolean, contract: object|null}>}
         */
        _waitForVirtualSettlement(contract_id, timeout_ms) {
            return new Promise(resolve => {
                let subscription;
                const timer = setTimeout(() => {
                    subscription?.unsubscribe();
                    // eslint-disable-next-line no-console
                    console.warn(
                        `[VH] Virtual contract ${contract_id} settlement timed out after ${timeout_ms}ms` +
                        ' — counted as a loss.'
                    );
                    resolve({ won: false, timedOut: true, contract: null });
                }, timeout_ms);

                subscription = api_base.api.onMessage().subscribe(({ data }) => {
                    if (data?.msg_type !== 'proposal_open_contract') return;
                    const contract = data.proposal_open_contract;
                    if (!contract || Number(contract.contract_id) !== Number(contract_id)) return;

                    const settled =
                        contract.is_sold === true ||
                        contract.status === 'won' ||
                        contract.status === 'lost';
                    if (!settled) return;

                    clearTimeout(timer);
                    subscription.unsubscribe();

                    let won;
                    if (contract.status === 'won') won = true;
                    else if (contract.status === 'lost') won = false;
                    else won = Number(contract.sell_price ?? 0) > Number(contract.buy_price ?? 0);

                    resolve({ won, timedOut: false, contract });
                });
                api_base.pushSubscription(subscription);
            });
        }

        /**
         * Compute a safe settlement timeout based on the configured contract
         * duration so virtual rounds can never hang the VH filter.
         * @returns {number}  Timeout in milliseconds.
         */
        _getVirtualSettlementTimeoutMs() {
            const { duration, duration_unit } = this.tradeOptions ?? {};
            const n = Number(duration) || 1;
            const unit_multiplier = { t: 1000, s: 1000, m: 60000, h: 3600000, d: 86400000 };
            const raw_ms = n * (unit_multiplier[duration_unit] ?? 60000);
            // Clamp between 30s and 30min, plus a 10s margin for API latency.
            return Math.min(Math.max(raw_ms, 30000), 1800000) + 10000;
        }

        /**
         * Orchestrates one full virtual contract round:
         *   submitVirtualProposal → submitVirtualBuy → waitForVirtualSettlement
         *
         * The actual API settlement outcome is returned — VH no longer uses a
         * local digit heuristic.
         *
         * @param {string} contract_type  Effective contract type being evaluated.
         * @returns {Promise<{won: boolean, contractId: string}|null>}
         *   null when any API step fails (retry without consuming a step).
         */
        async _runVirtualContractRound(contract_type) {
            // 1) Price the virtual contract (same infra as real proposals).
            const proposal = await this._submitVirtualProposal(contract_type);
            if (!proposal) return null;
            // eslint-disable-next-line no-console
            console.log(
                '[VH] Virtual proposal received' +
                ` | id=${proposal.id}` +
                ` | askPrice=${proposal.askPrice}`
            );

            // 2) Buy the virtual contract (same infra as the real buy path).
            const contract_id = await this._submitVirtualBuy(proposal.id, proposal.askPrice);
            if (!contract_id) return null;
            // eslint-disable-next-line no-console
            console.log('[VH] Virtual contract open | contractId=' + contract_id);

            // 3) Wait for the virtual contract to actually settle.
            const timeout_ms = this._getVirtualSettlementTimeoutMs();
            // eslint-disable-next-line no-console
            console.log(
                '[VH] waitForVirtualSettlement()' +
                ` | contractId=${contract_id}` +
                ` | timeoutMs=${timeout_ms}`
            );
            const settlement = await this._waitForVirtualSettlement(contract_id, timeout_ms);

            // eslint-disable-next-line no-console
            console.log(
                '[VH] Virtual contract settled' +
                ` | contractId=${contract_id}` +
                ` | won=${settlement.won}` +
                ` | timedOut=${settlement.timedOut}` +
                ` | status=${settlement.contract?.status ?? 'n/a'}`
            );

            // 4) Return the actual API outcome to the recordVirtualOutcome step.
            return { won: settlement.won, contractId: contract_id };
        }

        /**
         * Feed one virtual outcome into the existing VH state machine.
         * recordTick() decides PROCEED / DISCARD / CONTINUE exactly as before —
         * only the source of `won` changed (real contract settlement instead of
         * a digit heuristic).
         *
         * @param {boolean} won         Actual virtual contract outcome.
         * @param {string}  contract_id Virtual contract id (for logging).
         * @returns {'PROCEED'|'DISCARD'|'CONTINUE'}
         */
        _recordVirtualOutcome(won, contract_id) {
            const result = this.virtualHookRuntime.recordTick(won);
            // eslint-disable-next-line no-console
            console.log(
                '[VH] recordVirtualOutcome()' +
                ` | contractId=${contract_id}` +
                ` | won=${won}` +
                ` | steps=${this.virtualHookRuntime.steps}` +
                ` | wins=${this.virtualHookRuntime.wins}` +
                ` | result=${result}`
            );
            return result;
        }

        /**
         * Pre-trade filter — evaluates live market ticks to decide whether a
         * real trade should be placed or discarded.
         *
         * Flow per signal (CONTRACT-BASED):
         *   1. startSignal() resets per-signal counters.
         *   2. For each virtual round:
         *        a. submitVirtualProposal()    — price a virtual contract (vh_stake).
         *        b. submitVirtualBuy()         — buy the virtual contract via the API.
         *        c. waitForVirtualSettlement() — wait for the actual contract close.
         *        d. recordVirtualOutcome()     — feed the real API outcome into
         *                                       recordTick() → PROCEED | DISCARD | CONTINUE.
         *   3. Return true  (PROCEED) → caller executes the real trade.
         *      Return false (DISCARD) → caller drops this signal entirely.
         *
         * The real purchase that follows uses the stake already determined by the
         * trading engine.  vh_stake is used only for the virtual contracts, never
         * for real trade sizing.
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
                ` | minWins=${this.virtualHookRuntime.minWins}` +
                ` | vhStake=${this.virtualHookRuntime.stake}` +
                ` | MODE=CONTRACT-BASED`
            );

            let step = 0;
            let failed_rounds = 0;
            // eslint-disable-next-line no-constant-condition
            for (;;) {
                // Execute one complete virtual contract round through the API:
                //   submitVirtualProposal → submitVirtualBuy → waitForVirtualSettlement.
                // The actual API settlement determines won/lost — no local heuristic.
                // eslint-disable-next-line no-await-in-loop
                const outcome = await this._runVirtualContractRound(contract_type);

                if (outcome === null) {
                    // Transient API/network error. Do NOT consume a step — wait for
                    // the next tick and retry so rate-limit or market-closed hiccups
                    // never artificially DISCARD a signal.  However the retry is
                    // strictly bounded: once consecutive failures reach maxSteps,
                    // discard the signal so _purchaseInProgress is always released
                    // and the next trade signal can still execute.  Without this cap,
                    // a persistently unavailable API would spin forever inside the
                    // VH filter and block the bot permanently.
                    failed_rounds++;
                    if (failed_rounds >= this.virtualHookRuntime.maxSteps) {
                        // eslint-disable-next-line no-console
                        console.warn(
                            `[VH] ${failed_rounds} consecutive virtual rounds failed` +
                            ' — DISCARD signal to release the purchase pipeline.'
                        );
                        return false;
                    }
                    // eslint-disable-next-line no-console
                    console.warn('[VH] Virtual contract round failed — retrying without consuming a step.');
                    // eslint-disable-next-line no-await-in-loop
                    await this._waitForNextTick();
                    continue;
                }

                failed_rounds = 0;
                step++;
                const result = this._recordVirtualOutcome(outcome.won, outcome.contractId);

                // eslint-disable-next-line no-console
                console.log(
                    `[VH] Step ${step}/${this.virtualHookRuntime.maxSteps}` +
                    ` | contractType=${contract_type}` +
                    ` | contractId=${outcome.contractId}` +
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
