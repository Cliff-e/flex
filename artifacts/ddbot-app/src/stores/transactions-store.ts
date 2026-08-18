import { action, computed, makeObservable, observable, reaction } from 'mobx';
import { formatDate, isEnded } from '@/components/shared';
import { LogTypes } from '@/external/bot-skeleton';
import { normalizeContractSpots } from '@/external/bot-skeleton/services/tradeEngine/utils/normalize-contract';
import { ProposalOpenContract } from '@deriv/api-types';
import { TPortfolioPosition, TStores } from '@deriv/stores/types';
import { TContractInfo } from '../components/summary/summary-card.types';
import { transaction_elements } from '../constants/transactions';
import { appendExitDigit, extractLastDigit } from '../bot/sharedExitDigitHistory';
import { subscribeToVHTransactions } from '../bot/virtualHook/VHRuntime';
import type { TransactionRecord } from '../bot/virtualHook/TransactionPipeline';
import { getStoredItemsByKey, getStoredItemsByUser, setStoredItemsByKey } from '../utils/session-storage';
import RootStore from './root-store';

type TTransaction = {
    type: string;
    data?: string | TContractInfo;
};

type TElement = {
    [key: string]: TTransaction[];
};

export default class TransactionsStore {
    root_store: RootStore;
    core: TStores;
    disposeReactionsFn: () => void;

    constructor(root_store: RootStore, core: TStores) {
        this.root_store = root_store;
        this.core = core;
        this.is_transaction_details_modal_open = false;

        makeObservable(this, {
            elements: observable,
            active_transaction_id: observable,
            recovered_completed_transactions: observable,
            recovered_transactions: observable,
            is_called_proposal_open_contract: observable,
            is_transaction_details_modal_open: observable,
            virtual_transactions: observable.shallow,
            transactions: computed,
            mixed_transactions: computed,
            display_statistics: computed,
            onBotContractEvent: action.bound,
            onVHTransactionCommitted: action.bound,
            pushTransaction: action.bound,
            clear: action.bound,
            registerReactions: action.bound,
            recoverPendingContracts: action.bound,
            updateResultsCompletedContract: action.bound,
            sortOutPositionsBeforeAction: action.bound,
            recoverPendingContractsById: action.bound,
        });

        const disposeReactions = this.registerReactions();
        const unsubscribeVH = subscribeToVHTransactions(this.onVHTransactionCommitted);
        this.disposeReactionsFn = () => {
            disposeReactions();
            unsubscribeVH();
        };
    }
    TRANSACTION_CACHE = 'transaction_cache';

    elements: TElement = getStoredItemsByUser(this.TRANSACTION_CACHE, this.core?.client?.loginid, []);
    active_transaction_id: null | number = null;
    recovered_completed_transactions: number[] = [];
    recovered_transactions: number[] = [];
    is_called_proposal_open_contract = false;
    is_transaction_details_modal_open = false;
    /** VH rows remain separate from the real-account transaction cache. */
    virtual_transactions: TransactionRecord[] = [];

    get transactions(): TTransaction[] {
        if (this.core?.client?.loginid) return this.elements[this.core?.client?.loginid] ?? [];
        return [];
    }

    /**
     * Presentation-only history used by the Transactions tab and details
     * modal. Virtual rows are composed with real rows but never written to
     * `elements`, the account cache, or the real account balance.
     */
    get mixed_transactions(): TTransaction[] {
        const realRows = this.transactions
            .filter(row => row.type === transaction_elements.CONTRACT && typeof row.data === 'object')
            .map(row => ({ type: transaction_elements.CONTRACT, data: row.data as TContractInfo }));
        const virtualRows = this.virtual_transactions.map(record => ({
            type: transaction_elements.CONTRACT,
            data: this.toVirtualContract(record),
        }));

        return [...realRows, ...virtualRows].sort(
            (a, b) => this.transactionTimestamp(b.data) - this.transactionTimestamp(a.data)
        );
    }

    get statistics() {
        return this.calculateStatistics(this.transactions);
    }

    /** Combined REAL + VH figures for presentation surfaces only. */
    get display_statistics() {
        return this.calculateStatistics(this.mixed_transactions);
    }

    private calculateStatistics(rows: TTransaction[]) {
        let total_runs = 0;
        const trxs = rows.filter(
            trx => trx.type === transaction_elements.CONTRACT && typeof trx.data === 'object'
        );
        const statistics = trxs.reduce(
            (stats, { data }) => {
                const { profit, is_completed = false, buy_price, payout, bid_price } = data as TContractInfo;
                // The new trading API sometimes sends these financial fields
                // as strings rather than numbers. `+=` on a string operand
                // silently falls back to string concatenation instead of
                // addition (e.g. `0 + "0.10"` -> `"00.10"`), corrupting the
                // running total into garbage that then renders as 0.00 even
                // though each row's own value displays correctly. Coerce
                // explicitly before accumulating.
                const numeric_profit = Number(profit) || 0;
                const numeric_buy_price = Number(buy_price) || 0;
                const numeric_payout = Number(payout ?? bid_price) || 0;
                if (is_completed) {
                    if (numeric_profit > 0) {
                        stats.won_contracts += 1;
                        stats.total_payout += numeric_payout;
                    } else {
                        stats.lost_contracts += 1;
                    }
                    stats.total_profit += numeric_profit;
                    stats.total_stake += numeric_buy_price;
                    total_runs += 1;
                }
                return stats;
            },
            {
                lost_contracts: 0,
                number_of_runs: 0,
                total_profit: 0,
                total_payout: 0,
                total_stake: 0,
                won_contracts: 0,
            }
        );
        statistics.number_of_runs = total_runs;
        return statistics;
    }

    onVHTransactionCommitted(record: TransactionRecord) {
        if (!this.virtual_transactions.some(existing => existing.contractId === record.contractId)) {
            this.virtual_transactions = [...this.virtual_transactions, record];
        }
    }

    toggleTransactionDetailsModal = (is_open: boolean) => {
        this.is_transaction_details_modal_open = is_open;
    };

    onBotContractEvent(data: TContractInfo) {
        this.pushTransaction(data);
    }

    pushTransaction(data: TContractInfo) {
        // Defense-in-depth: normalize entry/exit/current/sell spot field
        // names here too, in case this contract data ever arrives via a
        // path other than OpenContract.js's observeOpenContract (e.g.
        // future portfolio-based recovery). Safe/idempotent if already
        // normalized upstream.
        const normalized_data = normalizeContractSpots(data) as TContractInfo;
        const is_completed = isEnded(normalized_data as ProposalOpenContract);
        const { run_id } = this.root_store.run_panel;
        const current_account = this.core?.client?.loginid as string;

        const contract: TContractInfo = {
            ...normalized_data,
            is_completed,
            run_id,
            date_start: formatDate(normalized_data.date_start, 'YYYY-M-D HH:mm:ss [GMT]'),
            // Prefer the display-value variant (nicer formatting), but the
            // new trading API often omits `*_display_value` fields entirely.
            // Fall back to the already-normalized numeric spot rather than
            // overwriting it with `undefined`, which is what left Entry/Exit
            // spot blank even after normalizeContractSpots resolved them.
            entry_tick: normalized_data.entry_tick_display_value ?? normalized_data.entry_tick,
            entry_tick_time:
                normalized_data.entry_tick_time && formatDate(normalized_data.entry_tick_time, 'YYYY-M-D HH:mm:ss [GMT]'),
            exit_tick: normalized_data.exit_tick_display_value ?? normalized_data.exit_tick,
            exit_tick_time:
                normalized_data.exit_tick_time && formatDate(normalized_data.exit_tick_time, 'YYYY-M-D HH:mm:ss [GMT]'),
            profit: is_completed ? normalized_data.profit : 0,
        };

        if (!this.elements[current_account]) {
            this.elements = {
                ...this.elements,
                [current_account]: [],
            };
        }

        const same_contract_index = this.elements[current_account]?.findIndex(c => {
            if (typeof c.data === 'string') return false;
            return (
                c.type === transaction_elements.CONTRACT &&
                c.data?.transaction_ids &&
                c.data.transaction_ids.buy === data.transaction_ids?.buy
            );
        });

        // ── SHARED EXIT-DIGIT HISTORY ─────────────────────────────────────────
        // This is the single authoritative append point for real settled
        // contracts.  Every trade — AI Bot strategy, AI Bot recovery, Blockly,
        // future engines — flows through pushTransaction.  We append the exit
        // digit exactly once: when the contract first transitions to completed.
        //
        // Deduplication logic:
        //   • INSERT path (same_contract_index === -1):
        //       Append if the contract is already completed on first insertion
        //       (e.g. recovered contracts that arrive pre-settled).
        //   • UPDATE path (same_contract_index !== -1):
        //       Only append if the stored record was NOT yet completed and the
        //       incoming data marks it as completed.  This is the normal flow
        //       for live trades: they arrive open first, then settle.
        if (is_completed) {
            const wasAlreadyCompleted =
                same_contract_index !== -1 &&
                typeof this.elements[current_account]?.[same_contract_index]?.data === 'object' &&
                !!(this.elements[current_account][same_contract_index].data as TContractInfo).is_completed;

            if (!wasAlreadyCompleted) {
                const exitTickRaw = normalized_data.exit_tick ?? 0;
                const digit = extractLastDigit(String(exitTickRaw));
                const won = (Number(normalized_data.profit) || 0) > 0;
                // Settlement identity — lets the shared history's bounded
                // dedup guarantee one entry per settled real contract even
                // if this transition ever fires twice for the same contract.
                const contractId =
                    normalized_data.contract_id != null ? String(normalized_data.contract_id) : undefined;
                const transactionId =
                    normalized_data.transaction_ids?.buy != null
                        ? String(normalized_data.transaction_ids.buy)
                        : undefined;
                appendExitDigit({ digit, source: 'REAL', won, ts: Date.now(), contractId, transactionId });
            }
        }

        if (same_contract_index === -1) {
            // Render a divider if the "run_id" for this contract is different.
            if (this.elements[current_account]?.length > 0) {
                const temp_contract = this.elements[current_account]?.[0];
                const is_contract = temp_contract.type === transaction_elements.CONTRACT;
                const is_new_run =
                    is_contract &&
                    typeof temp_contract.data === 'object' &&
                    contract.run_id !== temp_contract?.data?.run_id;

                if (is_new_run) {
                    this.elements[current_account]?.unshift({
                        type: transaction_elements.DIVIDER,
                        data: contract.run_id,
                    });
                }
            }

            this.elements[current_account]?.unshift({
                type: transaction_elements.CONTRACT,
                data: contract,
            });
        } else {
            // If data belongs to existing contract in memory, update it.
            this.elements[current_account]?.splice(same_contract_index, 1, {
                type: transaction_elements.CONTRACT,
                data: contract,
            });
        }

        this.elements = { ...this.elements }; // force update
    }

    clear() {
        if (this.elements && this.elements[this.core?.client?.loginid as string]?.length > 0) {
            this.elements[this.core?.client?.loginid as string] = [];
        }
        this.recovered_completed_transactions = this.recovered_completed_transactions?.slice(0, 0);
        this.recovered_transactions = this.recovered_transactions?.slice(0, 0);
        this.is_transaction_details_modal_open = false;
        this.virtual_transactions = [];
    }

    private transactionTimestamp(data: TContractInfo): number {
        if (typeof data.date_start === 'number') return data.date_start;
        const parsed = Date.parse(String(data.date_start ?? '').replace('[GMT]', 'GMT'));
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private toVirtualContract(record: TransactionRecord): TContractInfo {
        const currency = this.core?.client?.currency ?? 'USD';
        const entryTick = record.entryTick ?? record.entryDigit ?? undefined;
        const exitTick = record.exitTick ?? record.exitDigit ?? undefined;
        const payout = record.won ? record.stake + record.profit : 0;

        return {
            contract_id: record.contractId as unknown as number,
            transaction_ids: {
                buy: record.transactionId as unknown as number,
                sell: record.transactionId as unknown as number,
            },
            contract_type: record.contractType,
            underlying: record.symbol,
            display_name: 'Virtual Hook',
            currency,
            date_start: record.settledAt,
            entry_tick: entryTick,
            exit_tick: exitTick,
            buy_price: record.stake,
            payout,
            bid_price: payout,
            profit: record.profit,
            is_completed: true,
            is_sold: true,
            is_virtual: true,
            run_id: record.runId,
        } as unknown as TContractInfo;
    }

    registerReactions() {
        const { client } = this.core;

        // Write transactions to session storage on each change in transaction elements.
        const disposeTransactionElementsListener = reaction(
            () => this.elements[client?.loginid as string],
            elements => {
                const stored_transactions = getStoredItemsByKey(this.TRANSACTION_CACHE, {});
                stored_transactions[client.loginid as string] = elements?.slice(0, 5000) ?? [];
                setStoredItemsByKey(this.TRANSACTION_CACHE, stored_transactions);
            }
        );

        // User could've left the page mid-contract. On initial load, try
        // to recover any pending contracts so we can reflect accurate stats
        // and transactions.
        const disposeRecoverContracts = reaction(
            () => this.transactions.length,
            () => this.recoverPendingContracts()
        );

        return () => {
            disposeTransactionElementsListener();
            disposeRecoverContracts();
        };
    }

    recoverPendingContracts(contract = null) {
        this.transactions.forEach(({ data: trx }) => {
            if (
                typeof trx === 'string' ||
                trx?.is_completed ||
                !trx?.contract_id ||
                this.recovered_transactions.includes(trx?.contract_id)
            )
                return;
            this.recoverPendingContractsById(trx.contract_id, contract);
        });
    }

    updateResultsCompletedContract(contract: ProposalOpenContract) {
        const { journal, summary_card } = this.root_store;
        const { contract_info } = summary_card;
        const { currency, profit } = contract;

        if (contract.contract_id !== contract_info?.contract_id) {
            this.onBotContractEvent(contract);

            if (contract.contract_id && !this.recovered_transactions.includes(contract.contract_id)) {
                this.recovered_transactions.push(contract.contract_id);
            }
            if (
                contract.contract_id &&
                !this.recovered_completed_transactions.includes(contract.contract_id) &&
                isEnded(contract)
            ) {
                this.recovered_completed_transactions.push(contract.contract_id);

                journal.onLogSuccess({
                    log_type: profit && profit > 0 ? LogTypes.PROFIT : LogTypes.LOST,
                    extra: { currency, profit },
                });
            }
        }
    }

    sortOutPositionsBeforeAction(positions: TPortfolioPosition[], element_id?: number) {
        positions?.forEach(position => {
            if (!element_id || (element_id && position.id === element_id)) {
                const contract_details = position.contract_info;
                this.updateResultsCompletedContract(contract_details);
            }
        });
    }

    async recoverPendingContractsById(contract_id: number, contract: ProposalOpenContract | null = null) {
        // TODO: need to fix as the portfolio is not available now
        // const positions = this.core.portfolio.positions;
        const positions: unknown[] = [];

        if (contract) {
            this.is_called_proposal_open_contract = true;
            if (contract.contract_id === contract_id) {
                this.updateResultsCompletedContract(contract);
            }
        }

        if (!this.is_called_proposal_open_contract) {
            if (this.core?.client?.loginid) {
                const current_account = this.core?.client?.loginid;
                if (!this.elements[current_account]?.length) {
                    this.sortOutPositionsBeforeAction(positions);
                }

                const elements = this.elements[current_account];
                const [element = null] = elements;
                if (typeof element?.data === 'object' && !element?.data?.profit) {
                    const element_id = element.data.contract_id;
                    this.sortOutPositionsBeforeAction(positions, element_id);
                }
            }
        }
    }
}
