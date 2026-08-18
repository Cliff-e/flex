# Virtual Hook v2 — Phase 1 Public API Freeze

**Status:** FROZEN  
**Date:** 2026-08-05  
**Commit:** `e99bbf1` (feat(vh): add VirtualHookEngine core subsystem — Phase 1)

---

## Freeze Statement

The following public API surfaces are **frozen** as of Phase 1.

Future phases may NOT change these without explicit user approval:

| Surface | File | Frozen Members |
|---------|------|----------------|
| `VirtualHookEngine` | `VirtualHookEngine.ts` | `start(candidate): Promise<VHStartResult>`, `configure()`, `abort()`, `getStatus()`, `isEnabled()` |
| `TradeCandidate` | `TradeCandidate.ts` | `signalId`, `source`, `contractType`, `symbol`, `realStake`, `duration`, `durationUnit`, `currency`, `basis`, `prediction`, `tradeParams`, `generatedAt` |
| `VirtualContract` | `VirtualContract.ts` | `contractId`, `runId`, `roundIndex`, `candidate`, `proposalId`, `askPrice`, `virtualStake`, `derivContractId`, `createdAt`, `entryAt`, `entryTick`, `entryDigit`, `settledAt`, `exitTick`, `exitDigit`, `settlement`, `status`, `durationMs`, `timeoutAt` |
| `VHDecision` | `VHDecision.ts` | `AUTHORIZED`, `REJECTED`, `RETRY`, `STOPPED` |
| `VHStartResult` | `VirtualHookEngine.ts` | `decision`, `reason`, `roundsCompleted`, `wins`, `losses` |

---

## Rationale

This freeze prevents downstream integration churn. XML Phase 6 and AI Phase 7 integrations will compile against this exact surface. Any change requires:
1. A written change proposal.
2. User approval before implementation.
3. A new minor version tag.

---

## Dependency Graph (Verified Phase 1)

```
VirtualHookEngine.ts
    ├── VHDecision.ts          (enum)
    ├── TradeCandidate.ts      (interface + type guard)
    ├── VHConfig.ts            (config + defaults)
    ├── VirtualContract.ts     (factory + model)
    ├── SettlementEngine.ts    (canonical settlement functions)
    ├── VirtualPolicy.ts       (threshold evaluation)
    ├── ProposalAdapter.ts     (interface only)
    ├── TickObserver.ts        (interface only)
    ├── TransactionPipeline.ts (interface only)
    ├── VHLogger.ts            (interface + console impl)
    ├── VirtualStateMachine.ts (state machine)
    └── errors.ts              (typed error classes)

VirtualStateMachine.ts
    ├── VHLogger.ts
    └── errors.ts

SettlementEngine.ts
    └── TradeCandidate.ts

VirtualPolicy.ts
    ├── VHConfig.ts
    └── VHDecision.ts

VirtualContract.ts
    └── TradeCandidate.ts

index.ts
    └── (re-exports all public symbols — DAG leaves only)
```

### Verifications

- **No circular imports:** Every file imports only from "lower" files in the DAG. No file imports from `index.ts` internally.
- **No XML dependency:** No import of `Purchase.js`, `ActiveContract.js`, `VirtualHookRuntime.js`, or any `bot-skeleton` file.
- **No AI dependency:** No import of `TradingEngine.ts`, `AiBots.tsx`, `WebSocketManager.ts`, or `EventBus.ts`.
- **Compiles independently:** `npx tsc --noEmit` passes with zero errors in the `src/bot/virtualHook/` directory.

---

## Change Request Template

To propose a change to a frozen surface:

```markdown
## VH API Change Request
- **Surface:** [e.g., VirtualHookEngine.start]
- **Current:** [description]
- **Proposed:** [description]
- **Impact:** [which phases/callers affected]
- **Migration:** [how existing callers will be updated]
- **Approval:** [awaiting user]