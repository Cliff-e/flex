// =============================================================
// SummaryStore — Phase 3
//
// Read-only consumer of committed TransactionRecords.
//
// Data flow (strictly one-directional):
//
//     VirtualContract
//          ↓
//     TransactionPipeline
//          ↓
//     TransactionsStore.commit()
//          ↓
//     TransactionsStore.subscribe()
//          ↓
//     SummaryStore.onTransactionCommitted(record)
//          ↓
//     update incremental counters
//
// Summary is a PASSIVE consumer. It never writes to
// TransactionsStore, never modifies TransactionRecords, never
// modifies VirtualContracts and never triggers another
// transaction. Only committed transactions affect Summary.
//
// Event ownership: Summary subscribes ONLY to
// TransactionsStore.subscribe(). No polling, no pipeline hooks.
//
// Update rules:
//   • Summary updates only after a successful commit event.
//   • Failed transactions never reach the commit event, so
//     Summary never changes (rollback is automatic).
//   • Duplicate commits never reach the listener, so idempotent
//     commits remain idempotent — every committed transaction
//     affects Summary exactly once.
//   • Updates are O(1): incremental aggregates only.
// =============================================================

import type { TransactionRecord } from './TransactionPipeline';
import type { VHLogger } from './VHLogger';
import { ConsoleVHLogger } from './VHLogger';

/**
 * Derived aggregate statistics maintained exclusively from
 * committed TransactionRecords.
 *
 * Contains ONLY derived values — never mutable trade state.
 */
export interface VHSummary {
    /** Total number of committed trades. */
    totalTrades: number;

    /** Number of winning committed trades. */
    wins: number;

    /** Number of losing committed trades. */
    losses: number;

    /** Sum of winning profits (positive P&L only). */
    grossProfit: number;

    /** Sum of losing amounts (positive magnitude of negative P&L). */
    grossLoss: number;

    /** grossProfit - grossLoss. */
    netProfit: number;

    /** wins / totalTrades (0 when there are no trades). */
    winRate: number;

    /** Epoch ms of the most recently committed trade (0 if none). */
    lastTradeTime: number;
}

/**
 * Structured log event emitted once per successful commit.
 */
export interface VHSummaryUpdateEvent {
    event: 'vh.summary.updated';
    transactionId: string;
    previousSummary: VHSummary;
    newSummary: VHSummary;
    timestamp: number;
}

/**
 * Phase 3 — aggregate summary of committed virtual transactions.
 */
export class SummaryStore {
    private _summary: VHSummary = this._emptySummary();

    constructor(private readonly logger: VHLogger = new ConsoleVHLogger()) {}

    /** The current derived summary (defensive copy). */
    getSummary(): VHSummary {
        return { ...this._summary };
    }

    /**
     * Commit-event handler — the ONLY entry point that may update
     * Summary. Attach to TransactionsStore.subscribe().
     */
    onTransactionCommitted(record: TransactionRecord): void {
        const previousSummary = this._summary;
        this._summary = this._apply(previousSummary, record);

        this.logger.info('vh.summary.updated', {
            runId: record.runId,
            currentState: 'SUMMARY_UPDATED',
            reason: 'Committed transaction applied to summary.',
            transactionId: record.transactionId,
            contractId: record.contractId,
            previousSummary,
            newSummary: this._summary,
            timestamp: Date.now(),
        });
    }

    /** Reset the summary to an empty state (does not touch the store). */
    reset(): void {
        this._summary = this._emptySummary();
    }

    private _apply(summary: VHSummary, record: TransactionRecord): VHSummary {
        const profit = record.profit;
        const wins = summary.wins + (record.won ? 1 : 0);
        const losses = summary.losses + (record.won ? 0 : 1);
        const totalTrades = summary.totalTrades + 1;

        const grossProfit = profit > 0 ? summary.grossProfit + profit : summary.grossProfit;
        const grossLoss = profit < 0 ? summary.grossLoss + Math.abs(profit) : summary.grossLoss;

        return {
            totalTrades,
            wins,
            losses,
            grossProfit,
            grossLoss,
            netProfit: grossProfit - grossLoss,
            winRate: totalTrades > 0 ? wins / totalTrades : 0,
            lastTradeTime: record.settledAt,
        };
    }

    private _emptySummary(): VHSummary {
        return {
            totalTrades: 0,
            wins: 0,
            losses: 0,
            grossProfit: 0,
            grossLoss: 0,
            netProfit: 0,
            winRate: 0,
            lastTradeTime: 0,
        };
    }
}