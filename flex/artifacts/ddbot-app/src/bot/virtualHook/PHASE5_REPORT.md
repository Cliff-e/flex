# Phase 5 — Shared Exit Digit History Report

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
TransactionsStore.subscribe()
        ├────────► SummaryStore
        ├────────► VHJournalStore
        └────────► SharedExitDigitHistory (onTransactionCommitted)
```

The **existing** `sharedExitDigitHistory.ts` module (single global shared exit-digit history, no new implementation created) is now the **final read-only consumer** in the Virtual Hook pipeline — connected to the same single commit event as Summary and Journal.

## Ownership Chain (strict)

```
VirtualContract
      ↓
TransactionPipeline
      ↓
TransactionsStore.pushTransaction()
      ↓
TransactionsStore.subscribe()
      ├────────► SummaryStore
      ├────────► VHJournalStore
      └────────► SharedExitDigitHistory
```

## Files Changed

| File | Change |
|------|--------|
| `src/bot/sharedExitDigitHistory.ts` | Modified — capacity 25→21, added `onTransactionCommitted` (Phase 5 commit-event handler), `connectExitDigitHistoryToStore`, `isVHDigitContract`, `VH_DIGIT_CONTRACT_TYPES`, `setExitDigitHistoryLogger`, `subscribeToExitDigitHistory`; entries frozen on append; readers return defensive copies; legacy exports unchanged |
| `src/bot/__tests__/SharedExitDigitHistory.test.ts` | **NEW** — 38 Phase 5 tests |
| `src/bot/virtualHook/PHASE5_REPORT.md` | **NEW** — Phase 5 report |

## History Record

```ts
{
    contractId,
    transactionId,
    runId,
    roundIndex,
    digit,
    won,
    contractType,
    timestamp,   // record.settledAt (also ts for legacy consumers)
    source: "vh_virtual"
}
```

Entries are **immutable** (frozen on append); `getExitDigitHistory()` and subscription listeners receive defensive copies.

## Accepted Contracts (only these append)

`DIGITOVER` · `DIGITUNDER` · `DIGITMATCH` · `DIGITDIFF` · `DIGITEVEN` · `DIGITODD`

Ignored: `CALL`, `PUT`, and all future non-digit contracts (any contract type not in the accepted set).

## Update Rules (verified)

- **Only** `TransactionsStore.subscribe()` writes VH exit digits (no ticks, no proposals, no candidate signals, no polling).
- **Failed/rolled-back transactions** never reach the commit event → history unchanged (automatic rollback, no retries, no partial entries).
- **Duplicate commits** are deduplicated by `transactionId` AND `contractId` → the same committed transaction never appends twice.
- **Capacity fixed at 21** — FIFO, newest appended, oldest removed. Exactly 21 entries maximum, no exceptions.
- **O(1) append-only** — never rebuilds history, never rescans transactions.
- **Ordering preserved** — entries are appended in commit order.
- **Legacy behavior retained** — `appendExitDigit('virtual'/'real')`, `getExitDigitHistory()`, `getLastNDigits()`, `getLastExitDigit()`, `getExitDigitCount()`, `resetExitDigitHistory()`, `clearExitDigitHistory()`, `extractLastDigit()` all still exist and work (capacity now 21 for all writers).

## Logging

Each successful append emits exactly one structured `vh.exit_digit.appended` event containing `contractId`, `transactionId`, `digit`, `won`, `historyLength`, and `timestamp`. No duplicate logs.

## Tests Run

```
Test Suites: 11 passed, 11 total
Tests:       203 passed, 203 total
```

New Phase 5 tests (38):
- accepted contracts (6 digit types)
- rejected contracts (CALL/PUT + 5 non-digit types)
- one committed digit transaction → exactly one entry (full schema verified)
- non-digit contracts ignored (no entry, no log)
- digit contract without exit digit ignored
- mixed digit/non-digit stream
- duplicate commit never appends twice
- same transactionId / different contractId dedup
- same contractId / different transactionId dedup
- failed write never touches history
- recovery after failed transaction
- history never exceeds 21
- FIFO after 21 entries (oldest removed)
- ordering preserved across 21+ entries
- immutable (frozen) stored entries
- defensive copies (getExitDigitHistory)
- returned copies never affect stored history
- getLastNDigits ordering
- exactly one subscriber notification per append
- non-digit commits do not notify
- unsubscribe stops notifications
- exactly one `vh.exit_digit.appended` log per append with full payload
- 100 commits (FIFO + logs)
- 1000 commits (correct, O(1), FIFO)
- deterministic replay
- legacy appendExitDigit respects 21 FIFO
- clearExitDigitHistory resets state incl. dedup tracking

## TypeScript

`tsc --noEmit` — no type errors in any `virtualHook` file or `src/bot/sharedExitDigitHistory.ts` (pre-existing unrelated project errors untouched; none introduced by Phase 5).

## Git

- Branch: `vh-v2-migration`
- Commit: `feat(vh): connect SharedExitDigitHistory to TransactionsStore commit events (Phase 5)`
- Pushed to `origin/vh-v2-migration`
- **No frozen files modified** (TransactionsStore, TransactionPipeline, SummaryStore, VHJournalStore, TransactionRecord schema, VirtualContract, SettlementEngine, TradeCandidate, and all Phase 1–4 sources untouched). No Phase 1–4 files were modified in Phase 5 — `sharedExitDigitHistory.ts` is the only source file changed.

## Acceptance Criteria Met

| Criterion | Status |
|-----------|--------|
| One committed digit transaction → exactly one history entry | ✅ |
| Capacity fixed at 21 | ✅ |
| FIFO preserved | ✅ |
| Never duplicated | ✅ |
| Never written before commit | ✅ |
| Never written after rollback | ✅ |
| Only digit contracts recorded | ✅ |
| Summary unchanged | ✅ |
| Journal unchanged | ✅ |
| Transactions unchanged | ✅ |
| Previous phases untouched | ✅ |
| All previous tests pass | ✅ |
| New tests pass | ✅ |
| TypeScript clean for Virtual Hook | ✅ |