# VH Transaction Record — Schema Freeze

**Status:** FROZEN  
**Date:** 2026-08-05  
**Phase:** 2 (Post-approval audit)  
**Commit:** (audit commit)  

The canonical transaction schema below is frozen. Summary (Phase 3), Journal (Phase 4),
and SharedExitDigitHistory (Phase 5) must derive exclusively from this shape.
Any change requires a written change proposal and user approval.

## Canonical Interface

```ts
export interface TransactionRecord {
    /** Unique transaction id (UUID-derived). */
    transactionId: string;

    /** Run id — identifies the TradeCandidate run. */
    runId: string;

    /** Round index within the run (0, 1, 2, ...). */
    roundIndex: number;

    /** Virtual contract id this transaction is for. */
    contractId: string;

    /** Contract type evaluated. */
    contractType: string;

    /** Market symbol. */
    symbol: string;

    /** Virtual stake used. */
    stake: number;

    /** Virtual P&L: +stake on win, -stake on loss. */
    profit: number;

    /** Whether the virtual contract was a win. */
    won: boolean;

    /** Settled exit digit (0–9), or null for non-digit contracts. */
    exitDigit: number | null;

    /** How the settlement outcome was determined. */
    settlement: 'api' | 'timeout' | 'error';

    /** Always true — Virtual Hook transactions are virtual by definition. */
    isVirtual: true;

    /** Epoch ms when the contract settled — canonical timestamp / sort key. */
    settledAt: number;

    /** Marks the recording source. */
    source: 'vh_virtual';
}
```

## Invariants

| Invariant | Rule |
|-----------|------|
| Uniqueness | `transactionId` is unique repo-wide (TX-{contractId} in practice; contractId itself is a UUID). |
| One-per-contract | A `contractId` may appear at most once in the TransactionsStore. |
| Ordering | Store order is settlement-chronological: `settledAt` asc → `roundIndex` asc → `contractId` asc. |
| Immutability | Committed records are `Object.freeze`d. Readers receive defensive copies. |
| Ownership | Only `TransactionPipeline.process()` may call `TransactionsStore.pushTransaction()`. |
| Derivation | Summary/Journal/SharedExitDigitHistory derive from the single commit event (`store.subscribe`). |
| No reverse writes | Summary/Journal/history may never write back into the TransactionsStore. |

## Consumers

- `VHTransactionPipeline` — producer (normalize → commit)
- `TransactionsStore` — single sink + commit event source
- Summary (Phase 3), Journal (Phase 4), SharedExitDigitHistory (Phase 5) — read-only consumers

## Change Process

To modify any field of `TransactionRecord`:
1. Written change proposal (surface, current, proposed, impact, migration).
2. User approval.
3. Version bump of the freeze doc.