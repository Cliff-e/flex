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
export function mergeBalanceAccounts(
    existing: unknown,
    incoming: BalanceMessage
): { accounts: Record<string, AccountBalanceEntry>; [k: string]: unknown } {
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
        ? (existing as { accounts: Record<string, AccountBalanceEntry> })
        : { accounts: {} };
}
