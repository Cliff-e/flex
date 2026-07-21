import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getLastDigit, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { openContractReceived, purchaseSuccessful, sell } from './state/actions';
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

            // If the Virtual Hook is active, run a simulated trade instead of a
            // real API purchase.  Falls back to normal trading when the hook is
            // disabled or the virtual warm-up sequence has completed.
            if (this.virtualHookEnabled && this.virtualHookActive) {
                return this._executeVirtualTrade(contract_type);
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

        /**
         * Execute a virtual (simulated) trade.
         *
         * Simulates the full contract lifecycle — purchase sent → purchase
         * received → contract open → contract sold — without touching the
         * Deriv API.  The outcome is determined from the last tick digit so
         * the result is data-driven and consistent with live market behaviour.
         *
         * The method fires the same contractStatus events as a real trade so
         * the bot's before/during/after_purchase Blockly blocks all execute
         * normally, and the UI transaction log shows virtual entries.
         *
         * @param {string} contract_type  The contract type requested by the
         *                                Purchase block (e.g. 'DIGITDIFF').
         * @returns {Promise<void>}
         */
        async _executeVirtualTrade(contract_type) {
            const effective_type = this.activeContractOverride || contract_type;
            const virtualId = `virt_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

            // ── Step 1: Simulate purchase sent ────────────────────────────────
            contractStatus({ id: 'contract.purchase_sent', data: 0 });

            // ── Step 2: Simulate purchase received ────────────────────────────
            const fakeBuy = {
                transaction_id: virtualId,
                contract_id: virtualId,
                longcode: `Virtual ${effective_type} trade (simulated)`,
                buy_price: 0,
            };

            contractStatus({ id: 'contract.purchase_received', data: virtualId, buy: fakeBuy });
            this.contractId = virtualId;
            this.isSold = false;
            this.store.dispatch(purchaseSuccessful());

            if (this.is_proposal_subscription_required) {
                this.renewProposalsOnPurchase();
            }

            log(LogTypes.PURCHASE, { longcode: fakeBuy.longcode, transaction_id: virtualId });
            info({
                accountID: this.accountInfo?.loginid ?? 'virtual',
                totalRuns: this.updateAndReturnTotalRuns(),
                transaction_ids: { buy: virtualId },
                contract_type: effective_type,
                buy_price: 0,
            });

            // ── Step 3: Simulate contract open then settle ────────────────────
            return new Promise(resolve => {
                setTimeout(async () => {
                    try {
                        // Determine outcome from the current last tick digit.
                        const lastTickStr = await this.getLastTick(false, true);
                        const lastDigit = getLastDigit(String(lastTickStr));
                        const prediction = this.activePredictionOverride;
                        const won = this._determineVirtualOutcome(effective_type, lastDigit, prediction);

                        const fakeContract = {
                            contract_type: effective_type,
                            contract_id: virtualId,
                            transaction_ids: {
                                buy: virtualId,
                                sell: `${virtualId}_sell`,
                            },
                            is_sold: 1,
                            is_expired: 1,
                            is_valid_to_sell: 0,
                            status: won ? 'won' : 'lost',
                            profit: won ? 1 : -1,
                            profit_percentage: won ? 100 : -100,
                            bid_price: won ? 2 : 0,
                            buy_price: 1,
                            sell_price: won ? 2 : 0,
                            currency: this.options?.currency ?? 'USD',
                            longcode: fakeBuy.longcode,
                            entry_spot: lastTickStr,
                            entry_spot_display_value: String(lastTickStr),
                            exit_tick: lastTickStr,
                            exit_tick_display_value: String(lastTickStr),
                            exit_tick_time: Math.floor(Date.now() / 1000),
                            // Virtual flag — downstream code can inspect this to
                            // distinguish virtual from real contracts if needed.
                            is_virtual: true,
                        };

                        this.data.contract = fakeContract;

                        // Dispatch openContractReceived so DURING_PURCHASE scope
                        // becomes active and the bot's during_purchase block runs.
                        this.store.dispatch(openContractReceived());

                        // Short pause to let DURING_PURCHASE code complete.
                        await new Promise(r => setTimeout(r, 100));

                        this.isSold = true;

                        contractStatus({
                            id: 'contract.sold',
                            data: `${virtualId}_sell`,
                            contract: fakeContract,
                        });

                        // Notify virtual hook machinery — advances the counter and
                        // switches to real mode when the sequence completes.
                        this.onVirtualTradeComplete(won);

                        // Resolve the after_purchase promise so the bot's
                        // after_purchase block executes.
                        if (this.afterPromise) {
                            this.afterPromise();
                        }

                        // Transition Redux scope back to STOP/idle.
                        this.store.dispatch(sell());
                    } catch (err) {
                        // eslint-disable-next-line no-console
                        console.error('[VirtualHook] Error during virtual trade settlement:', err);
                        // Fail-safe: record as a loss and unblock the bot.
                        this.onVirtualTradeComplete(false);
                        if (this.afterPromise) {
                            this.afterPromise();
                        }
                        this.store.dispatch(sell());
                    }

                    resolve();
                }, 400);
            });
        }

        /**
         * Determine whether a virtual trade would have been a win based on the
         * last tick digit and the active contract type / prediction.
         *
         * @param {string}      contractType  e.g. 'DIGITOVER'
         * @param {number}      lastDigit     0–9
         * @param {number|null} prediction    Active prediction override, or null.
         * @returns {boolean}
         */
        _determineVirtualOutcome(contractType, lastDigit, prediction) {
            const pred = prediction !== null && prediction !== undefined ? Number(prediction) : null;

            switch (contractType) {
                case 'DIGITOVER':
                    // Win if last digit is strictly greater than prediction.
                    return pred !== null ? lastDigit > pred : lastDigit > 4;
                case 'DIGITUNDER':
                    // Win if last digit is strictly less than prediction.
                    return pred !== null ? lastDigit < pred : lastDigit < 5;
                case 'DIGITMATCH':
                    // Win if last digit exactly matches prediction.
                    return pred !== null ? lastDigit === pred : false;
                case 'DIGITDIFF':
                    // Win if last digit differs from prediction.
                    return pred !== null ? lastDigit !== pred : lastDigit !== 5;
                case 'DIGITEVEN':
                    return lastDigit % 2 === 0;
                case 'DIGITODD':
                    return lastDigit % 2 !== 0;
                case 'CALL':
                case 'CALLE':
                    // Simplified proxy: win if last digit > 4 (rough upward pressure).
                    return lastDigit > 4;
                case 'PUT':
                case 'PUTE':
                    return lastDigit <= 4;
                default:
                    // For contract types without a simple digit rule, use parity.
                    return lastDigit % 2 === 0;
            }
        }

        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
