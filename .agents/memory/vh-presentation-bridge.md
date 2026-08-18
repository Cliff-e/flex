---
name: Virtual Hook presentation bridge
description: The rule for combining VH history with real-trade panels without contaminating real account state.
---

Virtual Hook records must remain in their dedicated runtime store. The UI may compose them with real contracts for chronological history and combined displayed statistics, but the real transaction cache, real-only statistics used by trading logic, and account balance must stay unchanged.

**Why:** The VH isolation invariants explicitly require virtual outcomes never to alter real accounting, while users still need one usable Summary, Transactions, and Journal view.

**How to apply:** Add VH data through presentation subscriptions and a separate combined-statistics getter; do not append VH records to the real account transaction cache or reuse combined figures inside engine/accounting code.