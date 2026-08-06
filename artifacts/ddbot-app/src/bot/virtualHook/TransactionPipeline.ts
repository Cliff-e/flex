// =============================================================
// TransactionPipeline — Normalized recording pipeline
//
// Every completed VirtualContract must create a normalized
// transaction that automatically updates:
//   Transactions → Summary → Journal → Shared Exit Digit History
//
// This is the SINGLE recording pipeline for VH outcomes.
// The TransactionRecord schema below is FROZEN (see
// PHASE2_SCHEMA_FREEZE.md) — downstream phases must not change it
// without approval.
// =============================================================

import type { VirtualContract } from './VirtualContract';
import { TransactionsStore } from './TransactionsStore';

/**
 * A normalized, immutable transaction record for ONE settled
 * virtual contract.
 *
 * Canonical schema — FROZEN (PHASE2_SCHEMA_FREEZE.md).
 * Ordering invariant: the store persists records in
 * settlement-chronological order (settledAt asc; equal settledAt →
 * roundIndex asc; then contractId asc).
 */
export interface TransactionRecord {
    /** Unique transaction id (UUID-derived). */
    transactionId: string;

    /** Run id — identifies the TradeCandidate run. */
    runId: string;

    /** Round index within the run (0, 1, 2, ...). */
    roundIndex: number;

    /** Virtual contract id this transaction is for. */
    contractId: string;

    /** Contract type evaluated. */
    contractType: string;

    /** Market symbol. */
    symbol: string;

    /** Virtual stake used. */
    stake: number;

    /** Virtual P&L: +stake on win, -stake on loss. */
    profit: number;

    /** Whether the virtual contract was a win. */
    won: boolean;

    /** Settled exit digit (0–9), or null for non-digit contracts. */
    exitDigit: number | null;

    /** How the settlement outcome was determined. */
    settlement: 'api' | 'timeout' | 'error';

    /** Always true — Virtual Hook transactions are virtual by definition. */
    isVirtual: true;

    /** Epoch ms when the contract settled — canonical timestamp / sort key. */
    settledAt: number;

    /** Marks the recording source. */
    source: 'vh_virtual';
}

/**
 * Result of a transaction pipeline processing step.
 */
export interface TransactionResult {
    /** The transaction record that was processed. */
    transaction: TransactionRecord;

    /** Whether the record was appended (not a duplicate). */
    appended: boolean;

    /** Whether the shared exit digit history was updated. */
    exitDigitRecorded: boolean;

    /** Warnings encountered during the pipeline (non-fatal). */
    warnings: string[];
}

/**
 * The single recording pipeline for VH outcomes.
 *
 * Implementations must:
 *   1. Normalize a settled VirtualContract into a TransactionRecord.
 *   2. Append to the Transactions table (Phase 2).
 *   3. Update the Summary (Phase 3).
 *   4. Append to the Journal (Phase 4).
 *   5. Append the exit digit to the shared history (Phase 5).
 *
 * Duplicates must never be recorded: the same contractId may only
 * produce ONE transaction.
 */
export interface TransactionPipeline {
    /**
     * Process a completed virtual contract through all recording stages.
     *
     * @param contract - A settled VirtualContract (status SETTLED/TIMED_OUT/ERROR).
     * @returns The transaction result.
     */
    process(contract: VirtualContract): Promise<TransactionResult>;
}

/**
 * No-op pipeline used in Phase 1 before any stores are connected.
 * Records nothing but returns a valid result so the engine can
 * complete its lifecycle.
 */
export class NoopTransactionPipeline implements TransactionPipeline {
    async process(contract: VirtualContract): Promise<TransactionResult> {
        const transactionRecord: TransactionRecord = {
            transactionId: `TX-${contract.contractId}`,
            runId: contract.runId,
            roundIndex: contract.roundIndex,
            contractId: contract.contractId,
            contractType: contract.candidate.contractType,
            symbol: contract.candidate.symbol,
            stake: contract.virtualStake,
            profit: contract.settlement?.won ? contract.virtualStake : -contract.virtualStake,
            won: contract.settlement?.won ?? false,
            exitDigit: contract.exitDigit,
            settlement: contract.settlement?.source ?? 'error',
            isVirtual: true,
            settledAt: contract.settledAt ?? Date.now(),
            source: 'vh_virtual',
        };
        return {
            transaction: transactionRecord,
            appended: false,
            exitDigitRecorded: false,
            warnings: ['NoopTransactionPipeline: No stores connected yet.'],
        };
    }
}

/**
 * Phase 2 — the production recording pipeline.
 *
 * Wires the frozen flow:
 *
 *     VirtualContract
 *          ↓  (normalize)
 *     TransactionRecord
 *          ↓
 *     TransactionsStore.pushTransaction()
 *
 * Guarantees:
 *   • One settlement produces exactly one transaction.
 *   • Duplicate writes are impossible — the store is keyed by
 *     contractId and returns the existing record for re-processed
 *     contracts (idempotent).
 *   • Failed writes retry ONCE inside the store.
 *   • Fatal write failure rolls back — no record is registered.
 *   • Records are committed in settlement-chronological order and
 *     are immutable (see TransactionsStore).
 *
 * The Summary, Journal and Shared Exit Digit History stages are
 * intentionally NOT connected in Phase 2 (Phases 3–5) — this
 * pipeline records ONLY the TransactionsStore, exactly as the
 * phase plan requires.
 */
export class VHTransactionPipeline implements TransactionPipeline {
    /**
     * @param store - The Phase 2 TransactionsStore (the single sink).
     */
    constructor(private readonly store: TransactionsStore) {}

    async process(contract: VirtualContract): Promise<TransactionResult> {
        const transaction = this.normalize(contract);
        const result = await this.store.pushTransaction(transaction);

        const warnings: string[] = [];
        if (!result.appended) {
            warnings.push(`Duplicate contract ${contract.contractId} — existing transaction reused (idempotent).`);
        }

        return {
            transaction: result.record ?? transaction,
            appended: result.appended,
            exitDigitRecorded: false,
            warnings,
        };
    }

    /**
     * Normalize a settled VirtualContract into a TransactionRecord.
     * Pure mapping — no side effects.
     */
    private normalize(contract: VirtualContract): TransactionRecord {
        return {
            transactionId: `TX-${contract.contractId}`,
            runId: contract.runId,
            roundIndex: contract.roundIndex,
            contractId: contract.contractId,
            contractType: contract.candidate.contractType,
            symbol: contract.candidate.symbol,
            stake: contract.virtualStake,
            profit: contract.settlement?.won ? contract.virtualStake : -contract.virtualStake,
            won: contract.settlement?.won ?? false,
            exitDigit: contract.exitDigit,
            settlement: contract.settlement?.source ?? 'error',
            isVirtual: true,
            settledAt: contract.settledAt ?? Date.now(),
            source: 'vh_virtual',
        };
    }
}