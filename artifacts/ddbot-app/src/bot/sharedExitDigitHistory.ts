// =============================================================
// sharedExitDigitHistory.ts
//
// Single source of truth for the rolling exit-digit history used by:
//   • TradingEngine  — strategy/recovery decisions, DCircles analysis
//   • AiBots.tsx     — ExitDigitStrip display (via EngineStatus)
//
// Both virtual (monitoring-phase) and real (settled contract) digits
// are appended here in strict chronological order — no separate buffers.
// =============================================================

export interface ExitDigitEntry {
    /** The last digit of the exit tick (0–9). */
    digit: number;
    /** 'virtual' = monitoring-phase observation; 'real' = settled contract. */
    source: 'virtual' | 'real';
    /** Only meaningful for real trades: true = contract won, false = lost. */
    won?: boolean;
    /** Unix-ms timestamp of the digit being recorded. */
    ts: number;
}

const MAX_HISTORY = 25;

let _history: ExitDigitEntry[] = [];

// ─────────────────────────────────────────
// Writers
// ─────────────────────────────────────────

/**
 * Append one exit digit to the shared history, trimming to MAX_HISTORY entries.
 * Called by TradingEngine whenever a virtual observation or real trade settles.
 */
export function appendExitDigit(entry: ExitDigitEntry): void {
    _history.push(entry);
    if (_history.length > MAX_HISTORY) _history.shift();
}

/**
 * Clear the history. Call on bot start so each session begins fresh.
 */
export function resetExitDigitHistory(): void {
    _history = [];
}

// ─────────────────────────────────────────
// Readers
// ─────────────────────────────────────────

/**
 * Return a snapshot of the full history (chronological, oldest → newest).
 * Safe to mutate — callers receive a copy.
 */
export function getExitDigitHistory(): ExitDigitEntry[] {
    return [..._history];
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
 * Extract the last digit (0–9) from a raw exit-tick value.
 *
 * Works for:
 *   • integer ticks:  "1234567" → 7
 *   • decimal ticks:  "1234.56" → 6  (decimal point stripped before slicing)
 *   • number inputs:  1234567  → 7
 *
 * This is the application-wide canonical implementation. All code that needs
 * to derive an exit digit from a tick value should call this function rather
 * than re-implementing the logic locally.
 */
export function extractLastDigit(raw: string | number): number {
    return Number(String(raw).replace('.', '').slice(-1));
}
