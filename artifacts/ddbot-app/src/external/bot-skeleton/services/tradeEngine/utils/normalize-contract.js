/**
 * Normalizes `proposal_open_contract` payloads so the rest of the app can
 * always rely on the legacy Deriv WebSocket API v3 field names
 * (entry_tick*, exit_tick*, current_spot*, sell_spot*, tick_stream), no
 * matter which naming the underlying transport actually used.
 *
 * Why this exists: this app was migrated from the legacy `ws.derivws.com`
 * endpoint to the new trading API at `api.derivws.com`. Several other spots
 * in the codebase (see api-base.ts's `getActiveSymbols`) already had to add
 * a normalization shim because the new endpoint renames/rewires fields.
 * `proposal_open_contract` needed the same treatment: the UI (Transactions
 * table, transaction details, contract cards, summary card, download CSV)
 * all read `entry_tick` / `exit_tick` / `entry_spot` / `current_spot` /
 * `sell_spot` / `tick_stream`, but the live payload may only carry
 * differently-named or camelCase equivalents. Without this shim those UI
 * fields silently render as empty/loading forever, even though trading
 * itself works fine (the trade engine only reads `is_sold`/`profit`, which
 * are unaffected).
 *
 * This is applied once, as close to the wire as possible (OpenContract.js),
 * so every downstream consumer (bot-skeleton's own trade engine state,
 * transactions-store, run-panel-store, summary-card, contract cards,
 * transaction-details, CSV download) receives one consistent shape.
 */

/** Returns the first defined & non-null value found in `obj` among `keys`. */
function pick(obj, keys) {
    for (const key of keys) {
        const value = obj?.[key];
        if (value !== undefined && value !== null) return value;
    }
    return undefined;
}

/** Normalizes a single tick entry inside `tick_stream`. */
function normalizeTickItem(tick) {
    if (!tick || typeof tick !== 'object') return tick;
    return {
        ...tick,
        epoch: pick(tick, ['epoch', 'Epoch']),
        tick: pick(tick, ['tick', 'quote', 'Tick']),
        tick_display_value: pick(tick, ['tick_display_value', 'tickDisplayValue', 'quote_display_value']),
    };
}

/**
 * Returns a shallow copy of `contract` with the entry/exit/current/sell
 * spot fields (and their `_display_value` / `_time` siblings) normalized to
 * the legacy field names, regardless of what the live API actually sent.
 *
 * Field groups, in priority order (first present value wins):
 *   - entry:   entry_tick*        → entrySpot*        → entry_spot*
 *   - exit:    exit_tick*         → exit_spot*         → sell_spot* (fallback
 *              for contracts sold before natural expiry, where the API may
 *              never populate an `exit_tick`)
 *   - current: current_spot*      → currentSpot*
 *   - sell:    sell_spot*         → sellSpot*
 */
export function normalizeContractSpots(contract) {
    if (!contract || typeof contract !== 'object') return contract;

    const entry_tick = pick(contract, ['entry_tick', 'entrySpot', 'entry_spot']);
    const entry_tick_display_value = pick(contract, [
        'entry_tick_display_value',
        'entryTickDisplayValue',
        'entrySpotDisplayValue',
        'entry_spot_display_value',
    ]);
    const entry_tick_time = pick(contract, ['entry_tick_time', 'entryTickTime', 'entrySpotTime', 'entry_spot_time']);

    const sell_spot = pick(contract, ['sell_spot', 'sellSpot']);
    const sell_spot_display_value = pick(contract, ['sell_spot_display_value', 'sellSpotDisplayValue']);
    const sell_spot_time = pick(contract, ['sell_spot_time', 'sellSpotTime']);

    // exit_tick falls back to sell_spot: contracts sold before natural
    // expiry may never receive an `exit_tick` from the API — the spot at
    // the moment of sale (`sell_spot`) is the closest equivalent to show as
    // "Exit spot" in that case.
    const exit_tick = pick(contract, ['exit_tick', 'exitSpot', 'exit_spot']) ?? sell_spot;
    const exit_tick_display_value =
        pick(contract, ['exit_tick_display_value', 'exitTickDisplayValue', 'exitSpotDisplayValue', 'exit_spot_display_value']) ??
        sell_spot_display_value;
    const exit_tick_time =
        pick(contract, ['exit_tick_time', 'exitTickTime', 'exitSpotTime', 'exit_spot_time']) ?? sell_spot_time;

    const current_spot = pick(contract, ['current_spot', 'currentSpot']);
    const current_spot_display_value = pick(contract, ['current_spot_display_value', 'currentSpotDisplayValue']);
    const current_spot_time = pick(contract, ['current_spot_time', 'currentSpotTime']);
    const current_spot_high_barrier = pick(contract, ['current_spot_high_barrier', 'currentSpotHighBarrier']);
    const current_spot_low_barrier = pick(contract, ['current_spot_low_barrier', 'currentSpotLowBarrier']);

    const raw_tick_stream = pick(contract, ['tick_stream', 'tickStream']);
    const tick_stream = Array.isArray(raw_tick_stream) ? raw_tick_stream.map(normalizeTickItem) : raw_tick_stream;

    return {
        ...contract,
        entry_tick,
        entry_spot: entry_tick,
        entry_tick_display_value,
        entry_spot_display_value: entry_tick_display_value,
        entry_tick_time,
        exit_tick,
        exit_spot: exit_tick,
        exit_tick_display_value,
        exit_spot_display_value: exit_tick_display_value,
        exit_tick_time,
        current_spot,
        current_spot_display_value,
        current_spot_time,
        current_spot_high_barrier,
        current_spot_low_barrier,
        sell_spot,
        sell_spot_display_value,
        sell_spot_time,
        ...(raw_tick_stream !== undefined ? { tick_stream } : {}),
    };
}
