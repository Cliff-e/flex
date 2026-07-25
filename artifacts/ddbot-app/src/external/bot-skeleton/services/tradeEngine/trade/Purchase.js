import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
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

            // If setActiveContractOverride has been called (via the Contract Type
            // Switcher block), use that type instead of the one hardcoded in the
            // Purchase block.  Falls back to the original contract_type when no
            // override is active — full backward compatibility.
            const effective_type = this.activeContractOverride || contract_type;

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

            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);
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

        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
