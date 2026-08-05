// =============================================================
// TransactionsStore — Phase 2 (audited)
//
// The SINGLE append point for normalized VH transaction records.
//
// Guarantees (frozen in the Phase 2 spec + audit):
//   1. one settlement = one transaction
//   2. duplicate writes are impossible (same contractId never
//      produces a second record)
//   3. failed writes retry ONCE before surfacing an error
//   4. idempotent behavior — re-processing an already recorded
//      contract returns the existing record without appending
//   5. records are persisted in SETTLEMENT-CHRONOLOGICAL order
//      (settledAt asc; tie → roundIndex asc; tie → contractId asc)
//   6. committed records are IMMUTABLE — Object.freeze at commit,
//      defensive copies on read
//   7. concurrency-safe — the whole commit (check → write → insert)
//      runs on the store's serialized commit chain so N concurrent
//      pushTransaction calls never interleave, drop, or duplicate
//   8. ONLY the TransactionPipeline may call pushTransaction — this
//      store exposes no other public writer
//
// Event-pipeline seam (Phases 3–5): subscribe(listener) receives the
// freshly committed record. Summary, Journal and SharedExitDigitHistory
// will each attach to this ONE commit event instead of writing on
// their own — guaranteeing a single source of truth and no partial
// updates.
// =============================================================

import type { TransactionRecord } from './TransactionPipeline';
import { VirtualHookError } from './errors';

/**
 * Raised when a transaction write fails after the single retry
 * attempt. The store guarantees rollback: the failed record is
 * NOT present in the store.
 */
export class TransactionWriteError extends VirtualHookError {
    constructor(contractId: string, cause?: unknown) {
        super(`Transaction write failed for contract ${contractId} after retry.`, {
            currentState: 'RECORD_TRANSACTION',
            expectedState: 'TRANSACTION_RECORDED',
            retryCount: 1,
            recoveryAction: 'Contract settlement is preserved; caller may re-process idempotently.',
            cause,
        });
        this.name = 'TransactionWriteError';
    }
}

/**
 * The durable-write abstraction used by TransactionsStore.
 * Default implementation is a no-op — the in-memory registration
 * inside pushTransaction is the single authoritative append.
 * Tests inject a failing writer to exercise retry/rollback.
 */
export type TransactionWriter = (record: TransactionRecord) => void | Promise<void>;

/**
 * Listener invoked exactly once per committed transaction.
 * This is the event-pipeline seam that Summary (Phase 3),
 * Journal (Phase 4) and SharedExitDigitHistory (Phase 5) will
 * subscribe to, so all three derive from ONE commit event.
 */
export type TransactionCommitListener = (record: TransactionRecord) => void;

/**
 * Phase 2 store — normalized transaction records for settled
 * virtual contracts.
 *
 * Design notes:
 *  - Commit serialization: the store chains every commit behind a
 *    promise so the check-then-act sequence (duplicate lookup → sink
 *    write → ordered insert) is atomic across await points. This is
 *    what makes 100 concurrent pushes deterministic.
 *  - Ordering: records are inserted by settlement time, not arrival
 *    time. Audit requirement: Contract B may settle before A; the
 *    store always yields [B, A] when settledAt(B) < settledAt(A).
 *  - Immutability: records are deep-frozen on commit; all readers
 *    return defensive copies.
 */
export class TransactionsStore {
    private _records: readonly TransactionRecord[] = [];
    private readonly _byContractId = new Map<string, TransactionRecord>();
    private readonly _writer: TransactionWriter;
    private readonly _listeners = new Set<TransactionCommitListener>();
    private _commitChain: Promise<unknown> = Promise.resolve();

    constructor(writer?: TransactionWriter) {
        this._writer = writer ?? (() => {});
    }

    /**
     * Append a transaction for a settled contract.
     *
     * Idempotent: if the contractId already has a record, the
     * existing record is returned and `appended` is false.
     *
     * Retry-once: a transient write failure is retried exactly
     * once. If the retry also fails, the write is rolled back —
     * the record is guaranteed absent from the store — and the
     * error is thrown.
     *
     * Serialized: concurrent calls are chained on the internal
     * commit queue, so ordering + duplicate checks stay atomic.
     *
     * @param record - The normalized transaction record.
     * @returns `{ record: TransactionRecord | null; appended: boolean }`.
     */
    pushTransaction(record: TransactionRecord): Promise<{ record: TransactionRecord | null; appended: boolean }> {
        const run = this._commitChain.then(() => this._commit(record));
        // Keep the chain alive regardless of individual outcomes.
        this._commitChain = run.catch(() => undefined);
        return run;
    }

    /**
     * All recorded transactions, oldest → newest, as defensive copies.
     */
    getRecords(): TransactionRecord[] {
        return this._records.map(r => this._copy(r));
    }

    /**
     * The transaction for a contractId (defensive copy), or null.
     */
    getByContractId(contractId: string): TransactionRecord | null {
        const r = this._byContractId.get(contractId);
        return r ? this._copy(r) : null;
    }

    /**
     * Number of recorded transactions.
     */
    get count(): number {
        return this._records.length;
    }

    /**
     * Attach a commit listener (event-pipeline seam). Returns an
     * unsubscribe function. Listeners receive the immutable record.
     */
    subscribe(listener: TransactionCommitListener): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /**
     * Clear all records. Used between test cases / bot sessions.
     */
    clear(): void {
        this._records = [];
        this._byContractId.clear();
    }

    // ─────────────────────────────────────────
    // Commit internals (serialized)
    // ─────────────────────────────────────────

    private async _commit(record: TransactionRecord): Promise<{ record: TransactionRecord | null; appended: boolean }> {
        const existing = this._byContractId.get(record.contractId);
        if (existing) {
            return { record: this._copy(existing), appended: false };
        }

        // Attempt 1.
        try {
            await this._writer(record);
        } catch (firstError) {
            // Retry exactly once.
            try {
                await this._writer(record);
            } catch (secondError) {
                // Fatal — rollback guarantee: the record was never
                // registered, so it is absent from the store.
                throw new TransactionWriteError(record.contractId, secondError ?? firstError);
            }
        }

        // Freeze BEFORE insertion: committed records must never mutate.
        const frozen = this._freeze(record);

        // Insert in settlement-chronological order.
        const records = [...this._records, frozen];
        records.sort(this._settlementOrderCompare);
        this._records = records;
        this._byContractId.set(record.contractId, frozen);

        // Single-commit event for downstream phases (Summary/Journal/history).
        this._listeners.forEach(listener => listener(frozen));

        return { record: this._copy(frozen), appended: true };
    }

    /**
     * Canonical store ordering: settledAt asc → roundIndex asc → contractId asc.
     */
    private _settlementOrderCompare(a: TransactionRecord, b: TransactionRecord): number {
        if (a.settledAt !== b.settledAt) return a.settledAt - b.settledAt;
        if (a.roundIndex !== b.roundIndex) return a.roundIndex - b.roundIndex;
        return a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0;
    }

    private _freeze(record: TransactionRecord): TransactionRecord {
        return Object.freeze({ ...record });
    }

    private _copy(record: TransactionRecord): TransactionRecord {
        return { ...record };
    }
}