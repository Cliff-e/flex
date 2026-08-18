import { VHDecision } from '@/bot/virtualHook';
import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy, tradeOptionToProposal } from '../utils/helpers';
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

        /**
         * When true, the completion of the current purchase() call must NOT
         * dispatch purchaseSuccessful() (which moves scope to DURING_PURCHASE).
         * Used ONLY by purchaseMultiple() so the scope stays in BEFORE_PURCHASE
         * between batch members — allowing every member to route through the
         * normal purchase() flow. Always false for single purchases.
         */
        _deferPurchaseSuccessful = false;

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
                ` | vhEnabled=${this.virtualHookEngine?.isEnabled?.() ?? false}`
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

            // ── Virtual Hook gate ─────────────────────────────────────────────
            // MODE-GATE LATCH: latch the VH runtime mode at purchase
            // entry into a per-purchase execution context. The latch is
            // a const carried through every async continuation of THIS
            // purchase — no flag flip (manual disable, policy
            // deactivation, AUTHORIZED) before settlement can promote a
            // latched purchase to a real buy.
            //
            // When latched (VH active at entry), delegate to the VH gate:
            //   AUTHORIZED → virtual settlement/records already
            //                committed; deactivate the VH runtime mode,
            //                DISCARD this purchase — zero real buys.
            //   REJECTED   → drop the signal, no purchase
            //   STOPPED    → abort, no purchase
            //   RETRY      → re-submit the candidate (bounded)
            //
            // When unlatched (VH inactive at entry), purchase() behaves
            // exactly as before and delegates directly to the real
            // purchase path.
            const vhContext = { enteredWhileVH: Boolean(this._vhRuntimeActive) };
            if (vhContext.enteredWhileVH) {
                return this._runVirtualHookGate(contract_type, effective_type, vhContext);
            }

            // eslint-disable-next-line no-console
            console.log('[BUY TRACE] VH inactive at entry (unlatched) — proceeding directly to real purchase.');

            return this._executeRealPurchase(contract_type, effective_type);
        }

        /**
         * Execute a real funded purchase (proposal/buy path).
         *
         * This is the legacy real purchase pipeline, extracted intact from the
         * original purchase() entry point. It is invoked:
         *   • directly when the purchase entered UNLATCHED (VH runtime
         *     inactive at entry — exact legacy behaviour)
         *   • NEVER for a latched purchase — the mode-gate latch makes
         *     _executeRealPurchase unreachable for purchases that entered
         *     while VH was active, on every decision including AUTHORIZED
         *
         * The implementation (proposal selection, buy request + retry,
         * recovery engine, open contract monitoring) is unchanged.
         *
         * @param {string} contract_type   Raw contract type from the block.
         * @param {string} effective_type  Resolved effective contract type.
         * @returns {Promise<void>}
         */
        _executeRealPurchase(contract_type, effective_type) {
            // eslint-disable-next-line no-console
            console.log('[BUY TRACE] Executing real purchase.');

            const onSuccess = response => {
                // Buy acknowledged — scope transitions to DURING_PURCHASE via
                // purchaseSuccessful(); the scope guard takes over from here.
                this._purchaseInProgress = false;

                const { buy } = response;

                // eslint-disable-next-line no-console
                console.log(
                    `[VH] Buy response received | contract_id=${buy.contract_id}` +
                    ` | transaction_id=${buy.transaction_id}`
                );

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;

                // purchaseMultiple(): keep scope in BEFORE_PURCHASE until the
                // final batch member. Single purchases always dispatch.
                const dispatchPurchaseSuccessful = !this._deferPurchaseSuccessful;
                this._deferPurchaseSuccessful = false;
                if (dispatchPurchaseSuccessful) {
                    this.store.dispatch(purchaseSuccessful());
                }

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
         * Architectural rule: there is exactly ONE purchase execution path —
         * purchase(). This method is a thin sequencing wrapper that routes
         * EVERY member of the batch through purchase(), so each trade
         * independently flows through the same guards, Virtual Hook
         * authorization, proposal selection, buy + retry, recovery engine and
         * event emissions as a normal single purchase.
         *
         * No batch-specific authorization exists. The Virtual Hook remains
         * attached ONLY to purchase() via _runVirtualHookGate(). There is no
         * duplicate VH logic here and no second authorization flow.
         *
         * Sequencing preserved:
         *   • The scope guard (BEFORE_PURCHASE) is checked once at entry — it is
         *     never bypassed or weakened.
         *   • purchaseSuccessful() (scope → DURING_PURCHASE) is deferred until
         *     the final member so scope stays in BEFORE_PURCHASE for the whole
         *     batch (same observable behavior as the previous inline loop).
         *   • Between members, purchase() already renews proposals on
         *     completion; this method waits for proposalsReady before routing
         *     the next member through purchase().
         *   • When count === 1 the method delegates straight to purchase(),
         *     so non-bulk bots are completely unaffected.
         *
         * @param {string} contract_type  - Raw value from the Blockly dropdown
         *                                  (e.g. 'CALL', 'PUT', 'DISABLE').
         * @param {number} count          - Number of contracts to buy (≥ 1).
         * @returns {Promise<void>}
         */
        async purchaseMultiple(contract_type, count) {
            const totalBuys = Math.max(1, Math.floor(count) || 1);

            // Single-buy: delegate entirely to the standard purchase() pipeline.
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

            // eslint-disable-next-line no-console
            console.log(
                `[VH] Purchase.purchaseMultiple() ENTER | count=${totalBuys}` +
                ` | scope=${this.store.getState().scope}`
            );

            /**
             * Resolves once store.proposalsReady is true.
             * Used between batch members — purchase() already renewed the
             * proposals on completion; this just waits for them to be ready
             * before routing the next member through purchase().
             */
            const waitForProposals = () =>
                new Promise(resolve => {
                    if (this.store.getState().proposalsReady) { resolve(); return; }
                    const unsub = this.store.subscribe(() => {
                        if (this.store.getState().proposalsReady) { unsub(); resolve(); }
                    });
                });

            try {
                // ── Batch loop — every member is a normal purchase() ──────────
                for (let i = 0; i < totalBuys; i++) {
                    const isLast = i === totalBuys - 1;
                    // Keep scope in BEFORE_PURCHASE until the final member so
                    // purchase() can be re-entered for the next buy. The flag
                    // is consumed/reset inside _executeRealPurchase.onSuccess().
                    this._deferPurchaseSuccessful = !isLast;
                    // eslint-disable-next-line no-await-in-loop
                    await this.purchase(contract_type);
                    if (!isLast) {
                        // eslint-disable-next-line no-await-in-loop
                        await waitForProposals();
                    }
                }
            } finally {
                this._deferPurchaseSuccessful = false;
            }
        }

        // ── Virtual Hook engine delegation ────────────────────────────────────

        _vhMaxRetries = 3;

        _buildTradeCandidate(effective_type) {
            const tradeOptions = this.tradeOptions ?? {};
            const prediction =
                this.activePredictionOverride != null
                    ? this.activePredictionOverride
                    : (tradeOptions.prediction ?? null);
            const symbol = this.activeSymbolOverride ?? tradeOptions.symbol ?? '';
            const tradeParams = {};
            if (tradeOptions.barrier != null) tradeParams.barrier = tradeOptions.barrier;
            if (tradeOptions.barrierOffset != null) tradeParams.barrierOffset = tradeOptions.barrierOffset;
            if (tradeOptions.secondBarrierOffset != null) tradeParams.secondBarrierOffset = tradeOptions.secondBarrierOffset;
            if (tradeOptions.multiplier != null) tradeParams.multiplier = tradeOptions.multiplier;
            return {
                signalId: getUUID(),
                source: 'xml',
                contractType: effective_type,
                symbol,
                realStake: Number(tradeOptions.amount) || 0,
                duration: Number(tradeOptions.duration) || 1,
                durationUnit: tradeOptions.duration_unit || 't',
                currency: tradeOptions.currency || 'USD',
                basis: tradeOptions.basis || 'stake',
                prediction,
                tradeParams,
                generatedAt: Date.now(),
            };
        }

        async _runVirtualHookGate(contract_type, effective_type, vhContext) {
            let retries = 0;
            for (;;) {
                const candidate = this._buildTradeCandidate(effective_type);
                let result;
                try {
                    result = await this.virtualHookEngine.start(candidate);
                } catch (err) {
                    this._purchaseInProgress = false;
                    return Promise.resolve();
                }
                if (result.decision === VHDecision.AUTHORIZED) {
                    // LATCH GUARD — a purchase latched while VH was active
                    // can NEVER become a real buy, not even on AUTHORIZED.
                    // Virtual settlement and record commit already completed
                    // inside virtualHookEngine.start(); the switch-to-real
                    // decision therefore deactivates the VH runtime mode and
                    // DISCARDS this purchase — zero real buys. The NEXT new
                    // purchase (unlatched) uses the real pipeline unchanged.
                    if (!vhContext.enteredWhileVH) {
                        // Unreachable for a latched context — kept as the
                        // explicit latch guard on the sole real call site.
                        return this._executeRealPurchase(contract_type, effective_type);
                    }
                    this.deactivateVirtualHookRuntime?.();
                    this._purchaseInProgress = false;
                    // eslint-disable-next-line no-console
                    console.log(
                        `[VH] AUTHORIZED — latched purchase ${candidate.signalId} discarded` +
                        ' | VH runtime deactivated | real buys for this purchase: 0'
                    );
                    return Promise.resolve();
                }
                if (result.decision === VHDecision.REJECTED || result.decision === VHDecision.STOPPED) {
                    this._purchaseInProgress = false;
                    return Promise.resolve();
                }
                retries++;
                if (retries >= this._vhMaxRetries) {
                    // Latch guard: RETRY exhaustion of a latched purchase
                    // resolves without buying — never falls through to
                    // _executeRealPurchase.
                    this._purchaseInProgress = false;
                    return Promise.resolve();
                }
            }
        }

        // NOTE: There is intentionally NO batch authorization method here.
        // The Virtual Hook is attached exclusively to purchase() via
        // _runVirtualHookGate(). purchaseMultiple() routes every batch member
        // through purchase(), so each trade is independently authorized by the
        // single shared VH flow — exactly one authorization path exists.

        // All legacy Virtual Hook methods have been removed.
        // Responsibilities migrated to:
        //   • VirtualHookEngine        — authorization decisions
        //   • XmlProposalAdapter       — virtual proposal acquisition
        //   • XmlTickObserver          — shared tick observation
        //   • _buildTradeCandidate()   — XML data → TradeCandidate mapping
        //   • _runVirtualHookGate()    — decision routing
        //   • _executeRealPurchase()   — unchanged funded purchase pipeline

        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
