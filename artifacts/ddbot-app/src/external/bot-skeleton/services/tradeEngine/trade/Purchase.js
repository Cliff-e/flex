import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getLastDigit, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { VirtualHookRuntime } from '../runtime/VirtualHookRuntime';
import { openContractReceived, purchaseSuccessful, sell } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type) {
            // Prevent calling purchase twice.
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            // Gate: if the Virtual Hook runtime is in virtual mode, run a
            // simulated trade instead of a real API purchase.
            if (this.virtualHookRuntime.isVirtualMode()) {
                return this._executeVirtualTrade(contract_type);
            }

            // If setActiveContractOverride has been called (via the Contract Type
            // Switcher block), use that type instead of the one hardcoded in the
            // Purchase block.  Falls back to the original contract_type when no
            // override is active — full backward compatibility.
            const effective_type = this.activeContractOverride || contract_type;

            const onSuccess = response => {
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
         * Market-closed / invalid tick handling
         * ──────────────────────────────────────
         * getLastTick() resolves with 'MarketIsClosed' when the market has no
         * data.  An invalid tick must never be used to evaluate a virtual trade:
         * the VirtualHookRuntime counter must not advance, history must not be
         * recorded, and the same virtual trade is retried after a delay.
         *
         * Event ordering
         * ──────────────
         * afterPromise() is called BEFORE onVirtualTradeComplete() so that any
         * strategy block inside after_purchase which reads getVirtualHookStatus()
         * observes the pre-advance state.  A setTimeout(0) yield ensures the
         * after_purchase continuation has had the opportunity to run before the
         * runtime counter advances.
         *
         * @param {string} contract_type  e.g. 'DIGITDIFF'
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
                        // ── 3a: Obtain a valid tick, retrying when the market is closed ──
                        //
                        // Do not evaluate (and do not advance the runtime counter) until a
                        // valid numeric tick is available.  This ensures the configured
                        // virtual trade count always consists of real completed evaluations.
                        const RETRY_DELAY_MS = 5000;
                        const MAX_RETRIES = 72; // ~6 minutes of retrying

                        let lastTickStr;
                        let retries = 0;

                        while (true) {
                            lastTickStr = await this.getLastTick(false, true);

                            const isMarketClosed = lastTickStr === 'MarketIsClosed';
                            const isValidNumber = !isNaN(parseFloat(String(lastTickStr)));

                            if (!isMarketClosed && isValidNumber) {
                                break; // Valid tick — proceed with evaluation.
                            }

                            retries++;
                            if (retries > MAX_RETRIES) {
                                // eslint-disable-next-line no-console
                                console.warn(
                                    `[VirtualHook] Market unavailable after ${retries - 1} retries. ` +
                                    'Skipping virtual trade — counter not advanced.'
                                );
                                // Unblock the bot without recording anything.
                                if (this.afterPromise) this.afterPromise();
                                this.store.dispatch(sell());
                                resolve();
                                return;
                            }

                            // eslint-disable-next-line no-console
                            console.warn(
                                `[VirtualHook] Market closed or invalid tick ("${lastTickStr}"). ` +
                                `Retrying in ${RETRY_DELAY_MS / 1000}s ` +
                                `(attempt ${retries}/${MAX_RETRIES})...`
                            );
                            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                        }

                        // ── 3b: Evaluate outcome via the VirtualHookRuntime static helper ─
                        const lastDigit = getLastDigit(String(lastTickStr));
                        const prediction = this.activePredictionOverride ?? null;
                        const won = VirtualHookRuntime.determineOutcome(effective_type, lastDigit, prediction);

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
                            is_virtual: true,
                        };

                        this.data.contract = fakeContract;

                        // ── 3c: Fire lifecycle events ─────────────────────────────────────

                        // Dispatch openContractReceived so DURING_PURCHASE scope becomes
                        // active and the bot's during_purchase block runs.
                        this.store.dispatch(openContractReceived());

                        // Short pause to let DURING_PURCHASE code complete.
                        await new Promise(r => setTimeout(r, 100));

                        this.isSold = true;

                        contractStatus({
                            id: 'contract.sold',
                            data: `${virtualId}_sell`,
                            contract: fakeContract,
                        });

                        // ── 3d: Unblock after_purchase BEFORE advancing the runtime ───────
                        //
                        // afterPromise() resolves Bot.waitForAfter(), triggering the bot's
                        // after_purchase Blockly block.  Any strategy block inside
                        // after_purchase that reads getVirtualHookStatus() must see the
                        // pre-advance state, so VirtualHookRuntime.onVirtualTradeComplete()
                        // must not run until after_purchase has had the opportunity to
                        // execute.
                        //
                        // Calling afterPromise() then yielding via setTimeout(0) flushes
                        // the microtask queue so the after_purchase continuation runs before
                        // the runtime counter is advanced.
                        if (this.afterPromise) {
                            this.afterPromise();
                        }

                        // Transition Redux scope back to idle.
                        this.store.dispatch(sell());

                        // Yield so the after_purchase Blockly code runs first.
                        await new Promise(r => setTimeout(r, 0));

                        // Advance the VirtualHookRuntime — this is the single source of
                        // truth for counter/history; no other code updates these.
                        this.virtualHookRuntime.onVirtualTradeComplete(won);
                    } catch (err) {
                        // eslint-disable-next-line no-console
                        console.error('[VirtualHook] Unexpected error during virtual trade settlement:', err);
                        // Unblock the bot.  The runtime counter is intentionally NOT
                        // advanced — an unexpected error is not a valid evaluation and
                        // must not pollute the history.
                        if (this.afterPromise) {
                            this.afterPromise();
                        }
                        this.store.dispatch(sell());
                    }

                    resolve();
                }, 400);
            });
        }

        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
