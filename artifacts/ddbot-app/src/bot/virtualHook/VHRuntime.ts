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
import { connectExitDigitHistoryToStore, resetExitDigitHistory } from '../sharedExitDigitHistory';
import type { TransactionPipeline } from './TransactionPipeline';

/**
 * The single shared TransactionsStore for the application.
 * Created lazily on first use (engine construction) so the
 * overhead is zero when no bot session runs.
 */
let _store: TransactionsStore | null = null;

let _pipeline: VHTransactionPipeline | null = null;

let _wired = false;

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
    connectExitDigitHistoryToStore(store);

    _store = store;
    _wired = true;
    _pipeline = new VHTransactionPipeline(store);

    return _pipeline;
}

/**
 * Access the shared store (for diagnostics / tests). Returns null
 * before the first engine constructs the pipeline.
 */
export function getVHStore(): TransactionsStore | null {
    return _store;
}

/**
 * Whether the downstream consumers have been wired yet.
 */
export function isVHRuntimeWired(): boolean {
    return _wired;
}