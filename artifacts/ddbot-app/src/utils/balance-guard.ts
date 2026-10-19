/**
 * Guards against stale/duplicate account balance updates during Real↔Demo
 * account switching.
 *
 * These helpers are pure so the switching invariants can be unit-tested without
 * a live WebSocket. CoreStoreProvider uses them to filter and merge incoming
 * `balance` messages, preventing a previous account's socket from overwriting
 * the newly selected account's balance.
 */

type AccountBalanceEntry = { balance?: number; currency?: string; [k: string]: unknown };

export type BalanceAccountsMap = { accounts: Record<string, AccountBalanceEntry>; [k: string]: unknown };

export type AuthorizeBalancePayload = {
    loginid?: string;
    balance?: number | null;
    currency?: string;
};

export type BalanceMessage = {
    loginid?: string;
    balance?: number;
    currency?: string;
    accounts?: Record<string, AccountBalanceEntry>;
    [k: string]: unknown;
};

/**
 * True when a balance push should be applied for the active account.
 * Rejects pushes while unauthorized (e.g. mid-switch) or for a different
 * loginid than the one currently selected.
 */
export function isBalanceMessageRelevant(
    balance: BalanceMessage | undefined,
    activeLoginid: string,
    isAuthorized: boolean
): boolean {
    if (!isAuthorized) return false;
    if (!balance) return false;
    if (balance.loginid && balance.loginid !== activeLoginid) return false;
    return true;
}

/**
 * Merges an incoming balance payload into the existing per-account map.
 * Never wipes accounts that aren't present in the incoming message, so a
 * stale `accounts` map can't clear the freshly selected account's data.
 */
export function mergeBalanceAccounts(existing: unknown, incoming: BalanceMessage): BalanceAccountsMap {
    const prev =
        (existing as { accounts?: Record<string, AccountBalanceEntry> } | null | undefined)?.accounts ?? {};

    if (incoming.accounts) {
        return { ...((existing as Record<string, unknown>) ?? {}), accounts: { ...prev, ...incoming.accounts } };
    }

    if (incoming.loginid) {
        const current = { ...(prev[incoming.loginid] ?? {}) } as AccountBalanceEntry;
        if (incoming.balance != null) current.balance = incoming.balance;
        if (incoming.currency) current.currency = incoming.currency;
        return {
            ...((existing as Record<string, unknown>) ?? {}),
            accounts: { ...prev, [incoming.loginid]: current },
        };
    }

    return existing && Object.keys(existing as object).length
        ? (existing as BalanceAccountsMap)
        : { accounts: {} };
}

/**
 * Seeds the balance carried by an `authorize` response.
 *
 * The new trading API may deliver the authorize message before the React
 * message listener is attached (the header is in its authorizing state), so
 * this helper lets CoreStoreProvider seed the value from the EventBus instead
 * of relying on that transient subscription.
 *
 * Returns null when the payload cannot be trusted (no loginid / no finite
 * balance) so callers never write a fabricated value.
 */
export function seedAuthorizeBalance(
    existing: unknown,
    auth: AuthorizeBalancePayload | null | undefined
): BalanceAccountsMap | null {
    if (!auth?.loginid || auth.balance == null || !Number.isFinite(Number(auth.balance))) {
        return null;
    }

    return mergeBalanceAccounts(existing, {
        loginid: auth.loginid,
        balance: Number(auth.balance),
        currency: auth.currency,
    });
}

/**
 * Fills balance entries that are missing from the live map using the balances
 * fetched at login. Existing (live WS) values are never overwritten, so a
 * stale REST snapshot cannot replace a fresher balance push.
 *
 * Returns `existing` unchanged when nothing was added, allowing callers to
 * avoid needless store updates.
 */
export function fillMissingBalances(
    existing: unknown,
    incoming: Record<string, AccountBalanceEntry> | null | undefined
): BalanceAccountsMap | null {
    const prev = (existing as { accounts?: Record<string, AccountBalanceEntry> } | null | undefined)?.accounts ?? {};
    const accounts = { ...prev };
    let changed = false;

    Object.entries(incoming ?? {}).forEach(([loginid, entry]) => {
        if (!loginid || !entry || accounts[loginid]) return;
        accounts[loginid] = { ...entry };
        changed = true;
    });

    if (!changed) {
        return (existing as BalanceAccountsMap | null | undefined) ?? null;
    }

    return { ...((existing as Record<string, unknown>) ?? {}), accounts };
}
