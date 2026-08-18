import { getRoundedNumber } from '@/components/shared';
import { api_base } from '../../api/api-base';
import { contract as broadcastContract, contractStatus } from '../utils/broadcast';
import { normalizeContractSpots } from '../utils/normalize-contract';
import { openContractReceived, sell } from './state/actions';

export default Engine =>
    class OpenContract extends Engine {
        observeOpenContract() {
            if (!api_base.api) return;
            // eslint-disable-next-line no-console
            console.log('[VH] OpenContract.observeOpenContract() — proposal_open_contract subscription ACTIVE');
            const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data.msg_type === 'proposal_open_contract') {
                    const raw_contract = data.proposal_open_contract;

                    if (!raw_contract || !this.expectedContractId(raw_contract?.contract_id)) {
                        return;
                    }

                    // eslint-disable-next-line no-console
                    console.log(
                        `[VH] proposal_open_contract UPDATE received | contract_id=${raw_contract.contract_id}` +
                        ` | is_sold=${raw_contract.is_sold} | status=${raw_contract.status ?? 'open'}`
                    );

                    // Normalize entry/exit/current/sell spot field names — the new
                    // trading API (api.derivws.com) does not guarantee the same
                    // field names as the legacy WebSocket API v3. See
                    // normalize-contract.js for why this is needed.
                    const contract = normalizeContractSpots(raw_contract);

                    this.setContractFlags(contract);

                    this.data.contract = contract;

                    broadcastContract({ accountID: api_base.account_info.loginid, ...contract });

                    if (this.isSold) {
                        this.contractId = '';
                        clearTimeout(this.transaction_recovery_timeout);
                        this.updateTotals(contract);

                        contractStatus({
                            id: 'contract.sold',
                            data: contract.transaction_ids.sell,
                            contract,
                        });

                        // VH does not use real contract settlements — virtual outcomes
                        // are derived purely from tick data inside _runVirtualFilter()
                        // in Purchase.js.  Real contract settlements go straight to
                        // afterPromise() so the interpreter can continue normally.

                        if (this.afterPromise) {
                            // eslint-disable-next-line no-console
                            console.log('[VH] afterPromise() resolved — interpreter resumes (after_purchase)');
                            this.afterPromise();
                        }

                        this.store.dispatch(sell());
                    } else {
                        this.store.dispatch(openContractReceived());
                    }
                }
            });
            api_base.pushSubscription(subscription);
        }

        waitForAfter() {
            return new Promise(resolve => {
                this.afterPromise = resolve;
            });
        }

        setContractFlags(contract) {
            const { is_expired, is_valid_to_sell, is_sold, entry_tick } = contract;

            this.isSold = Boolean(is_sold);
            this.isSellAvailable = !this.isSold && Boolean(is_valid_to_sell);
            this.isExpired = Boolean(is_expired);
            this.hasEntryTick = Boolean(entry_tick);
        }

        expectedContractId(contractId) {
            return this.contractId && contractId === this.contractId;
        }

        getSellPrice() {
            const { bid_price: bidPrice, buy_price: buyPrice, currency } = this.data.contract;
            return getRoundedNumber(Number(bidPrice) - Number(buyPrice), currency);
        }
    };
