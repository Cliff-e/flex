// =============================================================
// sharedExitDigitHistory.ts
//
// Single source of truth for the rolling exit-digit history used by:
//   • TradingEngine  — strategy/recovery decisions, DCircles analysis
//   • AiBots.tsx     — ExitDigitStrip display (via EngineStatus)
//   • Virtual Hook pipeline — Phase 5: committed VH digit contracts
//
// There is exactly ONE global shared exit-digit history. Virtual
// Hook committed digit transactions append here via the SAME commit
// event used by Summary (Phase 3) and Journal (Phase 4):
//
//     TransactionsStore.subscribe()
//         ├────────► SummaryStore
//         ├────────► VHJournalStore
//         └────────► SharedExitDigitHistory (onTransactionCommitted)
//
// Only successful committed VH transactions are allowed to write
// through the Virtual Hook path. Never monitoring ticks, never
// proposal ticks, never candidate signals, never duplicate commits.
//
// SOURCES:
//   'VH'   — committed Virtual Hook settled contract
//   'REAL' — confirmed real Deriv settled contract
// A live monitoring tick is NOT an exit digit and must never reach
// this history.
// =============================================================

import type { TransactionRecord } from './virtualHook/TransactionPipeline';
import type { VHLogger } from './virtualHook/VHLogger';
import { ConsoleVHLogger } from './virtualHook/VHLogger';
import type { TransactionsStore } from './virtualHook/TransactionsStore';

/**
 * Contract types that append exit digits to the shared history
 * (Phase 5). Strictly the six digit contracts — CALL/PUT and future
 * non-digit contracts are deliberately excluded.
 */
export const VH_DIGIT_CONTRACT_TYPES = new Set<string>([
    'DIGITOVER',
    'DIGITUNDER',
    'DIGITMATCH',
    'DIGITDIFF',
    'DIGITEVEN',
    'DIGITODD',
]);

/**
 * Returns true when a contract type is an accepted digit contract
 * for the Virtual Hook exit-digit history.
 */
export function isVHDigitContract(contractType: string): boolean {
    return VH_DIGIT_CONTRACT_TYPES.has(contractType);
}

export interface ExitDigitEntry {
    /** The last digit of the exit tick (0–9). */
    digit: number;
    /** 'VH' = committed Virtual Hook settlement; 'REAL' = settled real contract. */
    source: 'VH' | 'REAL';
    /** Only meaningful for real trades: true = contract won, false = lost. */
    won?: boolean;
    /** Unix-ms timestamp of the digit being recorded. */
    ts: number;

    // ── Phase 5 extension fields (present only on committed-VH entries) ──
    /** Virtual contract id the committed transaction belongs to. */
    contractId?: string;
    /** Id of the committed transaction. */
    transactionId?: string;
    /** Run id — identifies the TradeCandidate run. */
    runId?: string;
    /** Round index within the run. */
    roundIndex?: number;
    /** Contract type of the committed transaction. */
    contractType?: string;
    /** Alias of `ts` — spec-compliant timestamp field for VH entries. */
    timestamp?: number;
}

/**
 * The Phase 5 history record shape produced for every committed VH
 * digit transaction. Immutable once appended.
 */
export interface VHExitDigitEntry extends ExitDigitEntry {
    source: 'VH';
    won: boolean;
    contractId: string;
    transactionId: string;
    runId: string;
    roundIndex: number;
    contractType: string;
    timestamp: number;
}

/**
 * Listener invoked exactly once per history entry appended.
 */
export type ExitDigitHistoryListener = (entry: ExitDigitEntry) => void;

const MAX_HISTORY = 25;

let _history: ExitDigitEntry[] = [];

// Bounded duplicate protection — the same settled contract must never
// append twice. The dedup identity map is pruned alongside the rolling
// history: when an entry ages out of the 25-entry buffer, its identity
// becomes eligible again. This prevents unbounded growth during long
// bot sessions.
let _dedupKeys: string[] = [];
const _dedupSet = new Set<string>();

const _listeners = new Set<ExitDigitHistoryListener>();

// Session-reset hooks — invoked whenever resetExitDigitHistory()
// restarts the session. The VH runtime uses this to re-arm the
// shared store so consumers remain subscribable after a rollback.
const _resetHooks = new Set<() => void>();

let _logger: VHLogger = new ConsoleVHLogger();

// ─────────────────────────────────────────
// Writers
// ─────────────────────────────────────────

function _pruneDedup(): void {
    while (_dedupKeys.length > MAX_HISTORY) {
        const oldest = _dedupKeys.shift();
        if (oldest !== undefined) _dedupSet.delete(oldest);
    }
}

/**
 * Append one exit digit to the shared history, trimming to MAX_HISTORY
 * (25) entries. FIFO: newest appended, oldest removed.
 *
 * The entry is frozen before storage; readers receive defensive copies.
 *
 * Deduplication: a settled contract may only produce ONE history entry.
 * EITHER settlement id is the identity — a previously seen contractId OR
 * transactionId (within the same source) marks the entry as a duplicate.
 * The dedup registry is bounded — identities of entries that age out of
 * the rolling buffer are removed, so a very long bot session never
 * accumulates unbounded memory.
 *
 * @returns true when the entry was appended, false when rejected as a
 * duplicate.
 */
export function appendExitDigit(entry: ExitDigitEntry): boolean {
    // ── Duplicate settlement protection ────────────────────────────
    // One settled transaction has ONE identity; presenting a known
    // transactionId under a different contractId (or vice versa) is
    // still the same settlement. Entries without any id (legacy
    // unidentified writes) have no dedup identity and pass through.
    const candidateKeys: string[] = [];
    if (entry.contractId) candidateKeys.push(`${entry.source}:contractId:${entry.contractId}`);
    if (entry.transactionId) candidateKeys.push(`${entry.source}:transactionId:${entry.transactionId}`);

    if (candidateKeys.length > 0) {
        if (candidateKeys.some(key => _dedupSet.has(key))) return false;
        candidateKeys.forEach(key => {
            _dedupSet.add(key);
            _dedupKeys.push(key);
        });
    }

    _history.push(Object.freeze({ ...entry }));
    if (_history.length > MAX_HISTORY) _history.shift();

    // Prune dedup identities that fell out of the rolling buffer.
    _pruneDedup();

    _listeners.forEach(listener => listener(_history[_history.length - 1]));
    return true;
}

/**
 * Phase 5 — Commit-event handler for the Virtual Hook pipeline.
 * Attach to TransactionsStore.subscribe().
 *
 * Rules:
 *   • ONLY successful committed VH transactions write.
 *   • Only the six accepted digit contract types append.
 *   • Non-digit contracts (CALL/PUT/future) are ignored.
 *   • The same committed transaction never appends twice
 *     (source+contractId/transactionId deduplication).
 *   • Rolled-back transactions never fire the commit event, so the
 *     history remains unchanged (automatic rollback). No retries.
 */
export function onTransactionCommitted(record: TransactionRecord): void {
    // Only accepted digit contracts, only with an exit digit.
    if (!isVHDigitContract(record.contractType)) return;
    if (record.exitDigit === null || record.exitDigit === undefined) return;

    const entry: VHExitDigitEntry = {
        digit: record.exitDigit,
        source: 'VH',
        won: record.won,
        ts: record.settledAt,
        timestamp: record.settledAt,
        contractId: record.contractId,
        transactionId: record.transactionId,
        runId: record.runId,
        roundIndex: record.roundIndex,
        contractType: record.contractType,
    };

    // The append event is emitted ONLY after the entry has passed
    // deduplication and was actually appended — one canonical append
    // equals exactly one event.
    const appended = appendExitDigit(entry);
    if (!appended) return;

    _logger.info('vh.exit_digit.appended', {
        runId: record.runId,
        currentState: 'EXIT_DIGIT_APPENDED',
        reason: 'Committed digit transaction appended to shared exit digit history.',
        contractId: record.contractId,
        transactionId: record.transactionId,
        digit: record.exitDigit,
        won: record.won,
        historyLength: _history.length,
        timestamp: Date.now(),
    });
}

/**
 * Phase 5 — Convenience wiring. Subscribes the shared exit-digit
 * history to a TransactionsStore's single commit event and returns
 * the unsubscribe function.
 */
export function connectExitDigitHistoryToStore(store: TransactionsStore): () => void {
    return store.subscribe(record => onTransactionCommitted(record));
}

/**
 * Injected logger override (for tests). Defaults to ConsoleVHLogger.
 */
export function setExitDigitHistoryLogger(logger: VHLogger): void {
    _logger = logger;
}

/**
 * Attach a session-reset hook invoked whenever resetExitDigitHistory()
 * runs. Returns an unsubscribe function.
 */
export function onExitDigitHistoryReset(hook: () => void): () => void {
    _resetHooks.add(hook);
    return () => {
        _resetHooks.delete(hook);
    };
}

/**
 * Clear the history. Call on bot start so each session begins fresh.
 * Also resets dedup tracking.
 */
export function resetExitDigitHistory(): void {
    _history = [];
    _dedupKeys = [];
    _dedupSet.clear();
    _resetHooks.forEach(hook => hook());
}

// ─────────────────────────────────────────
// Readers
// ─────────────────────────────────────────

/**
 * Return a snapshot of the full history (chronological, oldest → newest)
 * as defensive copies. Safe to mutate — callers receive copies.
 */
export function getExitDigitHistory(): ExitDigitEntry[] {
    return _history.map(e => ({ ...e }));
}

/**
 * Return the last N digit *values* (number[]) in chronological order.
 * Used by TradingEngine for strategy/recovery decisions (replaces the
 * old getLast20Digits() that incorrectly concatenated virtual + real arrays).
 */
export function getLastNDigits(n: number): number[] {
    const slice = _history.slice(-n);
    return slice.map(e => e.digit);
}

/**
 * Return the last N **confirmed** digit *values* (number[]) in chronological
 * order. "Confirmed" means the digit was committed by the canonical
 * Transactions panel pipeline (`source: 'REAL'`).
 *
 * Recovery decisions must NEVER read VH-virtual (`source: 'VH'`)
 * digits — they are not settled real-trade exits. This function
 * guarantees recovery consumes only committed confirmations from
 * the single rolling history.
 */
export function getLastNConfirmedDigits(n: number): number[] {
    const confirmed = _history.filter(e => e.source === 'REAL').slice(-n);
    return confirmed.map(e => e.digit);
}

/**
 * Return the digit value of the most recently recorded entry, or null when
 * the history is empty.
 */
export function getLastExitDigit(): number | null {
    return _history.length ? _history[_history.length - 1].digit : null;
}

/**
 * Return the number of entries currently stored in the history.
 */
export function getExitDigitCount(): number {
    return _history.length;
}

/**
 * Alias for resetExitDigitHistory — exposed as a Blockly-callable action.
 */
export function clearExitDigitHistory(): void {
    _history = [];
    _dedupKeys = [];
    _dedupSet.clear();
}

/**
 * Attach a history listener. Returns an unsubscribe function.
 * Listeners receive the immutable entry exactly once per append.
 */
export function subscribeToExitDigitHistory(listener: ExitDigitHistoryListener): () => void {
    _listeners.add(listener);
    return () => _listeners.delete(listener);
}

/**
 * Extract the last digit (0–9) from a raw exit-tick value.
 * This is the application-wide canonical implementation.
 */
export function extractLastDigit(raw: string | number): number {
    return Number(String(raw).replace('.', '').slice(-1));
}