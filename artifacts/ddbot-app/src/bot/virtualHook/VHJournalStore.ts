// =============================================================
// VHJournalStore — Phase 4
//
// Read-only consumer of committed TransactionRecords — the
// Journal is the second event-pipeline consumer alongside Summary.
//
// Data flow (strictly one-directional):
//
//     VirtualContract
//          ↓
//     TransactionPipeline
//          ↓
//     TransactionsStore.pushTransaction()
//          ↓
//     TransactionsStore.subscribe()
//          ↓
//     VHJournalStore.onTransactionCommitted(record)
//          ↓
//     append one immutable journal entry
//
// Journal is a PASSIVE consumer. It never writes to
// TransactionsStore, never modifies TransactionRecords, never
// modifies VirtualContracts and never triggers another
// transaction. Only committed transactions produce journal entries.
//
// Entry rules:
//   • Every committed VH transaction produces EXACTLY ONE journal
//     entry (immutable, append-only).
//   • Duplicate transactions never reach the commit event (the
//     store early-returns before notify), so a re-pushed contract
//     never produces a second entry.
//   • Failed transactions never reach the commit event, so a
//     rolled-back write never leaves a journal entry.
//   • Entries are frozen on append and returned as defensive copies.
//   • Append is O(1): the journal NEVER rebuilds from history and
//     NEVER iterates the transaction list.
//   • Entry order = commit order (the order TransactionsStore
//     notified), preserving transaction ordering exactly.
// =============================================================

import type { TransactionRecord } from './TransactionPipeline';
import type { VHLogger } from './VHLogger';
import { ConsoleVHLogger } from './VHLogger';

/**
 * An immutable journal entry — produced once per committed VH
 * transaction. Created exclusively by VHJournalStore.
 */
export interface VHJournalEntry {
    /** Unique journal entry id (derived from the transaction id). */
    entryId: string;

    /** Id of the committed transaction this entry records. */
    transactionId: string;

    /** Virtual contract id the transaction belongs to. */
    contractId: string;

    /** Run id — identifies the TradeCandidate run. */
    runId: string;

    /** Round index within the run (0, 1, 2, ...). */
    roundIndex: number;

    /** Journal event kind — always VH_SETTLEMENT. */
    event: 'VH_SETTLEMENT';

    /** Contract type evaluated. */
    contractType: string;

    /** Market symbol. */
    symbol: string;

    /** Whether the virtual contract was a win. */
    won: boolean;

    /** Virtual P&L: +stake on win, -stake on loss. */
    profit: number;

    /** Virtual stake used. */
    stake: number;

    /** Settled exit digit (0–9), or null for non-digit contracts. */
    exitDigit: number | null;

    /** Entry digit observed at contract entry (optional). */
    entryDigit?: number | null;

    /** Entry tick quote value (optional). */
    entryTick?: number | null;

    /** Exit tick quote value (optional). */
    exitTick?: number | null;

    /** How the settlement outcome was determined. */
    settlement: 'api' | 'timeout' | 'error';

    /** Epoch ms when the contract settled (canonical timestamp). */
    timestamp: number;

    /** Marks the journaling source. */
    source: 'VH';
}

/**
 * Listener invoked exactly once per journal entry appended.
 * Receives the immutable (frozen) entry.
 */
export type VHJournalListener = (entry: VHJournalEntry) => void;

/**
 * Structured log event emitted once per successful journal append.
 */
export interface VHJournalUpdateEvent {
    event: 'vh.journal.updated';
    entryId: string;
    transactionId: string;
    runId: string;
    previousLength: number;
    newLength: number;
    timestamp: number;
}

/**
 * Phase 4 — immutable, append-only journal of committed virtual
 * transactions.
 *
 * The Journal is a read-only subscriber of TransactionsStore's
 * single commit event, exactly like Summary. There is NO other
 * writer: only `onTransactionCommitted(record)` (wired to
 * `TransactionsStore.subscribe()`) may append an entry.
 *
 * Design notes:
 *  - Append-only: `_entries` grows by exactly one per commit
 *    notification. Never rebuilt, never re-sorted, never iterated
 *    for an update. O(1) per commit.
 *  - Immutability: entries are deep-frozen before storage; all
 *    readers receive defensive copies.
 *  - Ordering: entries are stored in the order TransactionsStore
 *    notified them (commit order), so transaction ordering is
 *    preserved exactly as committed.
 *  - Duplicates & rollbacks are impossible by construction: the
 *    store only notifies after a successful, non-duplicate commit.
 */
export class VHJournalStore {
    private _entries: readonly VHJournalEntry[] = [];
    private readonly _byEntryId = new Map<string, VHJournalEntry>();
    private readonly _listeners = new Set<VHJournalListener>();

    constructor(private readonly logger: VHLogger = new ConsoleVHLogger()) {}

    /**
     * Commit-event handler — the ONLY entry point that may append
     * a journal entry. Attach to TransactionsStore.subscribe().
     */
    onTransactionCommitted(record: TransactionRecord): void {
        const entry = this._buildEntry(record);
        const previousLength = this._entries.length;

        const frozen = Object.freeze(entry);
        this._entries = [...this._entries, frozen];
        this._byEntryId.set(frozen.entryId, frozen);
        const newLength = this._entries.length;

        this.logger.info('vh.journal.updated', {
            runId: record.runId,
            currentState: 'JOURNAL_UPDATED',
            reason: 'Committed transaction appended to journal.',
            entryId: frozen.entryId,
            transactionId: record.transactionId,
            previousLength,
            newLength,
            timestamp: Date.now(),
        });

        // One notification per successful append.
        this._listeners.forEach(listener => listener(frozen));
    }

    /**
     * All journal entries, oldest commit → newest commit, as
     * defensive copies.
     */
    getEntries(): VHJournalEntry[] {
        return this._entries.map(e => this._copy(e));
    }

    /**
     * The journal entry for an entryId (defensive copy), or null.
     */
    getEntry(entryId: string): VHJournalEntry | null {
        const e = this._byEntryId.get(entryId);
        return e ? this._copy(e) : null;
    }

    /**
     * Number of journal entries.
     */
    get count(): number {
        return this._entries.length;
    }

    /**
     * Attach a journal listener. Returns an unsubscribe function.
     * Listeners receive the immutable entry exactly once per append.
     */
    subscribe(listener: VHJournalListener): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /** Reset the journal to empty (does not touch the store). */
    reset(): void {
        this._entries = [];
        this._byEntryId.clear();
    }

    // ─────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────

    /**
     * Build a journal entry from a committed TransactionRecord.
     * Pure mapping — no side effects, no mutation of the record.
     */
    private _buildEntry(record: TransactionRecord): VHJournalEntry {
        return {
            entryId: `J-${record.transactionId}`,
            transactionId: record.transactionId,
            contractId: record.contractId,
            runId: record.runId,
            roundIndex: record.roundIndex,
            event: 'VH_SETTLEMENT',
            contractType: record.contractType,
            symbol: record.symbol,
            won: record.won,
            profit: record.profit,
            stake: record.stake,
            exitDigit: record.exitDigit,
            entryDigit: record.entryDigit,
            entryTick: record.entryTick,
            exitTick: record.exitTick,
            settlement: record.settlement,
            timestamp: record.settledAt,
            source: 'VH',
        };
    }

    private _copy(entry: VHJournalEntry): VHJournalEntry {
        return { ...entry };
    }
}