import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type) {
            // Prevent calling purchase twice
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            // If setActiveContractOverride has been called (via the Contract Type
            // Switcher block), use that type instead of the one hardcoded in the
            // Purchase block.  Falls back to the original contract_type when no
            // override is active — full backward compatibility.
            const effective_type = this.activeContractOverride || contract_type;

            const onSuccess = response => {
                // Don't unnecessarily send a forget request for a purchased contract.
                const { buy } = response;

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
                        // if disconnected no need to resubscription (handled by live-api)
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
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
