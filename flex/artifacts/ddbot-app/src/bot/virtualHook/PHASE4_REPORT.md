# Phase 4 — Journal Integration Report

## Status: COMPLETE

## Architecture

```
VirtualContract
        │
        ▼
TransactionPipeline
        │
        ▼
TransactionsStore.pushTransaction()
        │
        ▼
TransactionsStore.subscribe()   ← single commit event seam
        │
        ▼
VHJournalStore.onTransactionCommitted(record)
        │
        ▼
append ONE immutable journal entry (O(1))
```

The Journal is a **read-only, passive consumer** of committed `TransactionRecord`s — exactly like Summary (Phase 3). It never writes to `TransactionsStore`, never modifies records, never touches `VirtualContract`s, and never triggers another transaction. **Nothing else may write journal entries.**

## Ownership Chain (strict)

```
VirtualContract
      ↓
TransactionPipeline
      ↓
TransactionsStore.pushTransaction()
      ↓
TransactionsStore.subscribe()
      ↓
VHJournalStore.onTransactionCommitted()
```

## Files Changed

| File | Change |
|------|--------|
| `src/bot/virtualHook/VHJournalStore.ts` | **NEW** — `VHJournalStore` class + `VHJournalEntry` / `VHJournalListener` / `VHJournalUpdateEvent` types |
| `src/bot/virtualHook/index.ts` | Added Journal exports (additive — Phase 1/2/3 exports unchanged) |
| `src/bot/virtualHook/__tests__/VHJournalStore.test.ts` | **NEW** — 19 journal tests |

## Journal Entry Schema

```ts
interface VHJournalEntry {
    entryId: string;        // J-<transactionId>
    transactionId: string;
    contractId: string;
    runId: string;
    roundIndex: number;
    event: 'VH_SETTLEMENT';
    contractType: string;
    symbol: string;
    won: boolean;
    profit: number;
    stake: number;
    exitDigit: number | null;
    settlement: 'api' | 'timeout' | 'error';
    timestamp: number;      // record.settledAt
    source: 'vh_virtual';
}
```

Journal entries are **immutable** (deep-frozen on append) and all readers receive **defensive copies**.

## Update Rules (verified)

- **Only** `TransactionsStore.subscribe()` appends to the Journal (no polling, no pipeline hooks, no settlement hooks, no engine hooks).
- **Failed/rolled-back transactions** never reach the commit event → Journal is unchanged (rollback is automatic).
- **Duplicate transactions** never reach the commit event (store early-returns before notify) → idempotent commits never append a second entry.
- **O(1) append-only** — never a rebuild from full history, never an iteration of the transaction list.
- **Ordering** — entries are appended in commit order, preserving transaction ordering exactly as committed.
- **Immutability** — entries frozen on append; `getEntries()` / `getEntry()` return defensive copies.

## Logging

Each successful append emits exactly one structured `vh.journal.updated` event containing `entryId`, `transactionId`, `runId`, `previousLength`, `newLength`, and `timestamp`. No duplicate logs.

## Tests Run

```
Test Suites: 10 passed, 10 total
Tests:       165 passed, 165 total
```

New Journal tests (19):
- single transaction → exactly one entry (full schema verified)
- multiple transactions → entries in commit order
- duplicate transaction ignored (no second entry, one log)
- failed write never reaches the journal
- journal survives failed write — later success still appends
- exactly one notification per committed transaction
- duplicate commit does not notify again
- unsubscribe stops notifications
- entries in chronological commit order
- transaction ordering preserved exactly as committed
- stored entries are immutable (frozen)
- `getEntries()` returns defensive copies
- `getEntry()` returns a defensive copy
- mutating a returned entry never affects the journal
- exactly one `vh.journal.updated` log per entry with full payload
- 100 committed transactions → 100 entries in order
- 1000 committed transactions → correct, O(1), unique entryIds
- deterministic replay produces identical journal
- incremental appends remain correct after every commit

## TypeScript

`tsc --noEmit` — no type errors in any `virtualHook` file (pre-existing unrelated project errors untouched; none introduced by Phase 4).

## Git

- Branch: `vh-v2-migration`
- Commit: `feat(vh): connect JournalStore to TransactionsStore commit events (Phase 4)`
- Pushed to `origin/vh-v2-migration`
- **No Phase 1/2/3 files modified** (TransactionsStore, TransactionPipeline, SummaryStore, TransactionRecord schema, and all frozen Phase 1–3 sources untouched).

## Acceptance Criteria Met

| Criterion | Status |
|-----------|--------|
| One committed transaction → exactly one journal entry | ✅ |
| Never duplicated | ✅ |
| Never written before commit | ✅ (only the commit event appends) |
| Never written after rollback | ✅ |
| No changes to previous phases | ✅ |
| All previous tests still pass | ✅ |
| New journal tests pass | ✅ |
| TypeScript clean for Virtual Hook | ✅ |