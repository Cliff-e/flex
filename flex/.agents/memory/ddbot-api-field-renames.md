---
name: Deriv API field-rename migration
description: api.derivws.com renames/rejects fields vs legacy ws.derivws.com; normalize at the wire boundary, not per-consumer.
---

## proposal_open_contract field renames
New endpoint renames several proposal_open_contract fields to camelCase (e.g. entry_tick_display_value variants may be absent). Normalize once at the wire boundary (store/transform layer), not per-consumer, and always fall back to the base normalized field when a display-value variant is missing.

## req_id / echo_req correlation
api.derivws.com does not always echo `req_id` at the top level of `proposal`/`buy` responses. Match using `msg.req_id ?? msg.echo_req?.req_id`. This same class of issue was already worked around in bot-skeleton for `passthrough` (via echo_req.passthrough) — check that precedent first when a request/response correlation silently stalls.

## symbol -> underlying_symbol on proposal requests
**Rule:** api.derivws.com rejects the `symbol` field on `proposal` requests with `InputValidationFailed: Properties not allowed: symbol`. Use `underlying_symbol` instead.
**Why:** bot-skeleton's tradeOptionToProposal (helpers.js) already carries this fix with a comment; a duplicate/standalone trade engine (AI Bots' TradingEngine) that builds its own proposal payload independently was missing it, causing every single proposal to error and no buy to ever fire (looked like "stuck on Executing forever" from the outside).
**How to apply:** Whenever a new trade-execution code path builds its own `proposal`/`buy` payloads by hand instead of reusing bot-skeleton's helpers, cross-check it against tradeOptionToProposal/tradeOptionToBuy in helpers.js for these api.derivws.com-specific field renames before assuming a different root cause.

## General lesson
Any code that builds its own Deriv WS payloads outside of bot-skeleton's shared helpers is a likely place for these api.derivws.com incompatibilities to resurface, since fixes are being applied piecemeal rather than centrally.
