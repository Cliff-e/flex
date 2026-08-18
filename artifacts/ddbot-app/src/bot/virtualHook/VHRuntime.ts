// =============================================================
// VHRuntime — Production runtime wiring for the Virtual Hook
// recording pipeline (Phases 2–5).
//
// This module owns the SINGLE shared TransactionsStore instance
// used by both trading engines (XML Blockly and AI Bots) and
// subscribes the downstream consumers exactly once:
//
//     TransactionsStore.subscribe()
//         ├────────► SummaryStore
//         ├────────► VHJournalStore
//         └────────► SharedExitDigitHistory
//
// Engines obtain the production pipeline via
// getVHTransactionPipeline(), so every settled virtual contract
// flows through:
//
//     VirtualContract → VHTransactionPipeline → TransactionsStore
//         → Summary → Journal → Shared Exit Digit History
//
// There is exactly ONE store and ONE set of subscribers per
// application lifetime.
// =============================================================

import { TransactionsStore } from './TransactionsStore';
import { VHTransactionPipeline } from './TransactionPipeline';
import { SummaryStore } from './SummaryStore';
import { VHJournalStore } from './VHJournalStore';
import type { TransactionRecord } from './TransactionPipeline';
import {
    connectExitDigitHistoryToStore,
    onExitDigitHistoryReset,
    resetExitDigitHistory,
} from '../sharedExitDigitHistory';
import type { TransactionPipeline } from './TransactionPipeline';

/**
 * The single shared TransactionsStore for the application.
 * Created lazily on first use (engine construction) so the
 * overhead is zero when no bot session runs.
 */
let _store: TransactionsStore | null = null;

let _pipeline: VHTransactionPipeline | null = null;

let _wired = false;

/** Whether the runtime has ever been wired (sticky across resets). */
let _everWired = false;

/**
 * Rollback recovery: a session-level reset (resetExitDigitHistory)
 * arms the runtime, so after a rollback/teardown the shared store is
 * re-materialized on next access instead of staying permanently null.
 * resetVHRuntime() is the hard teardown and disarms.
 */
let _armed = false;

/**
 * Presentation consumers (the run-panel stores) can subscribe before the
 * lazily-created VH store exists.  The runtime fans out committed records
 * without exposing the VH store as part of real-account state.
 */
const _transactionListeners = new Set<(record: TransactionRecord) => void>();

onExitDigitHistoryReset(() => {
    _armed = true;
});

/**
 * Reset the shared runtime to a fresh state (clears the store and
 * the downstream subscribers' state). Intended for test isolation
 * and bot-session resets.
 */
export function resetVHRuntime(): void {
    _store = null;
    _pipeline = null;
    _wired = false;
    resetExitDigitHistory();
    // Hard teardown disarms AFTER the session reset above fired the
    // arming hook: the store stays down until the NEXT session reset
    // re-arms the runtime.
    _armed = false;
}

/**
 * Get the production recording pipeline (VHTransactionPipeline over
 * the shared store). Subscribes Summary, Journal, and Exit Digit
 * History to the store exactly once.
 */
export function getVHTransactionPipeline(): TransactionPipeline {
    if (_pipeline) return _pipeline;

    const store = new TransactionsStore();
    const summary = new SummaryStore();
    const journal = new VHJournalStore();

    store.subscribe(record => summary.onTransactionCommitted(record));
    store.subscribe(record => journal.onTransactionCommitted(record));
    store.subscribe(record => {
        _transactionListeners.forEach(listener => listener(record));
    });
    connectExitDigitHistoryToStore(store);

    _store = store;
    _wired = true;
    _everWired = true;
    _pipeline = new VHTransactionPipeline(store);

    return _pipeline;
}

/**
 * Subscribe to VH commits for presentation-only consumers. Existing records
 * are replayed once so a panel mounted after VH starts still shows history.
 */
export function subscribeToVHTransactions(listener: (record: TransactionRecord) => void): () => void {
    _transactionListeners.add(listener);
    _store?.getRecords().forEach(listener);
    return () => _transactionListeners.delete(listener);
}

/**
 * Access the shared store (for diagnostics / tests). Returns null
 * before the first engine constructs the pipeline, and immediately
 * after a hard resetVHRuntime() teardown until the next session
 * reset re-arms the runtime. Once armed after a rollback, the clean
 * fully-wired store is re-materialized so consumers can subscribe.
 */
export function getVHStore(): TransactionsStore | null {
    if (!_store && _armed && _everWired) {
        // Rollback left the runtime torn down, but a fresh session
        // started — rebuild the shared store so it remains usable.
        getVHTransactionPipeline();
    }
    return _store;
}

/**
 * Whether the downstream consumers have been wired yet.
 */
export function isVHRuntimeWired(): boolean {
    return _wired;
}