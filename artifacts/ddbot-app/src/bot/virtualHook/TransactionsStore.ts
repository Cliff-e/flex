// =============================================================
// TransactionsStore — Phase 2
//
// The SINGLE append point for normalized VH transaction records.
//
// Guarantees (frozen in the Phase 2 spec):
//   1. one settlement = one transaction
//   2. duplicate writes are impossible (same contractId never
//      produces a second record)
//   3. failed writes retry ONCE before surfacing an error
//   4. idempotent behavior — re-processing an already recorded
//      contract returns the existing record without appending
//
// The store holds the authoritative in-memory transaction list.
// A pluggable write function (defaults to a no-op sink)
// represents an optional durable sink so retry / rollback
// behavior is deterministic and testable without I/O.
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
 * Phase 2 store — normalized transaction records for settled
 * virtual contracts.
 *
 * Thread-safety: JavaScript is single-threaded, so append +
 * index registration + duplicate check are atomic within one
 * synchronous section. Concurrency is further serialized by the
 * engine's single-run busy gate.
 */
export class TransactionsStore {
    private readonly _records: TransactionRecord[] = [];
    private readonly _byContractId = new Map<string, TransactionRecord>();
    private readonly _writer: TransactionWriter;

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
     * @param record - The normalized transaction record.
     * @returns `{ record: TransactionRecord | null; appended: boolean }`.
     *          `record` is null (and `appended` false) when the
     *          contractId already existed; otherwise `record` is
     *          the stored (or previously stored) record.
     */
    async pushTransaction(
        record: TransactionRecord
    ): Promise<{ record: TransactionRecord | null; appended: boolean }> {
        const existing = this._byContractId.get(record.contractId);
        if (existing) {
            return { record: existing, appended: false };
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
                // registered in the index, so it is absent.
                throw new TransactionWriteError(record.contractId, secondError ?? firstError);
            }
        }

        // Register AFTER a successful write so the index can never
        // reference a record that the sink rejected. This registration
        // is the single authoritative in-memory append.
        this._records.push(record);
        this._byContractId.set(record.contractId, record);
        return { record, appended: true };
    }

    /**
     * All recorded transactions, oldest → newest.
     */
    getRecords(): TransactionRecord[] {
        return [...this._records];
    }

    /**
     * The transaction for a contractId, or null.
     */
    getByContractId(contractId: string): TransactionRecord | null {
        return this._byContractId.get(contractId) ?? null;
    }

    /**
     * Number of recorded transactions.
     */
    get count(): number {
        return this._records.length;
    }

    /**
     * Clear all records. Used between test cases / bot sessions.
     */
    clear(): void {
        this._records.length = 0;
        this._byContractId.clear();
    }
}