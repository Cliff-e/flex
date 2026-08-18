# Virtual Hook v2 — Phase 2 Report: TransactionsStore

**Date:** 2026-08-05
**Branch:** `vh-v2-migration` (from `vh-phase1-stable`)
**Commit:** `d8d2d20` — feat(vh): connect TransactionsStore to TransactionPipeline (Phase 2)

## Scope

Phase 2 connected the normalized transaction recording store to the frozen
`TransactionPipeline` interface. Per the phase plan, only the following were
modified:

- `VirtualHook/TransactionPipeline.ts` — added `VHTransactionPipeline` (normalize → store)
- `VirtualHook/TransactionsStore.ts` — **new** store
- `VirtualHook/index.ts` — additive exports for the Phase 2 additions
- `VirtualHook/__tests__/TransactionsStore.test.ts` — **new** test suite

**Not touched:** Summary, Journal, SharedExitDigitHistory, VirtualHookEngine,
VirtualStateMachine, SettlementEngine, ProposalAdapter, TickObserver,
VirtualContract, VirtualPolicy. All remain frozen.

## Pipeline

```
VirtualContract
      ↓  (normalize)
TransactionRecord
      ↓
TransactionsStore.pushTransaction()
```

## Guarantees implemented

| Requirement | Implementation |
|-------------|----------------|
| one settlement = one transaction | `pushTransaction` appends exactly once per unique `contractId` |
| duplicate writes impossible | contractId-keyed `Map` returns existing record; `appended=false` |
| failed writes retry once | writer called once, retried exactly once on transient failure |
| idempotent behavior | re-processing a recorded contract returns existing record without re-append |

## Tests

`__tests__/TransactionsStore.test.ts` — 6 tests:

1. **successful write** — one settled contract → one transaction record
2. **duplicate prevention** — same contract processed twice → count stays 1
3. **retry after failure** — transient writer failure → retried → succeeds (2 calls)
4. **rollback on fatal failure** — persistent failure → `TransactionWriteError`, record absent

## Verification

- `npx jest src/bot/virtualHook --no-coverage --forceExit` → **7 suites, 120 tests, all pass**
- `npx tsc --noEmit` (virtualHook scope) → **0 errors**

## Notes

- The Phase 2 store defaults to an in-memory registration (no-op sink). A durable
  sink can be injected via the `TransactionWriter` constructor parameter for
  persistence/retry/rollback testing.
- `TransactionWriteError` extends `VirtualHookError` with structured context
  (`RECORD_TRANSACTION` → `TRANSACTION_RECORDED`, `retryCount: 1`).

## Next Phase

Phase 3 — Summary integration (only after this report is reviewed).