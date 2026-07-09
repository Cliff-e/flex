/**
 * REST balance refresh — DigitalOcean backend.
 *
 * Fetches fresh account balances from the DO backend's /api/auth/accounts
 * endpoint and merges them into localStorage (clientAccounts, restAccounts).
 * Never throws — returns null on any failure so callers can degrade gracefully.
 */

import { API_BASE_URL } from './pkce';
import { AuthSessionManager } from './AuthSessionManager';

interface RestAccount {
    account_id?: string;
    id?: string;
    loginid?: string;
    balance?: number | string;
    currency?: string;
    account_currency?: string;
    account_type?: string;
    type?: string;
}

export interface BalanceRefreshResult {
    activeBalance: string;
    activeCurrency: string;
    allAccounts: Record<string, { balance: number; currency: string; status: number; type: string }>;
}

/**
 * Fetch fresh balances from the DO backend for all accounts.
 * Updates localStorage (clientAccounts, restAccounts) and returns
 * structured data ready to push into MobX observables.
 */
export async function refreshBalancesFromRest(
    accessToken: string,
    activeLoginId: string
): Promise<BalanceRefreshResult | null> {
    if (!API_BASE_URL) {
        console.warn('[balance-refresh] VITE_API_BASE_URL not set — skipping refresh');
        return null;
    }

    const { appId } = AuthSessionManager.getAuthInfo();

    try {
        const res = await fetch(`${API_BASE_URL}/api/auth/accounts`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Deriv-App-ID': appId,
                'Cache-Control': 'no-cache',
            },
        });

        if (!res.ok) {
            console.warn('[balance-refresh] REST accounts returned', res.status);
            return null;
        }

        const json = await res.json();
        const rawList: RestAccount[] =
            (json?.data as RestAccount[] | undefined) ??
            (json?.accounts as RestAccount[] | undefined) ??
            (Array.isArray(json) ? (json as RestAccount[]) : []);

        if (!rawList.length) return null;

        const allAccounts: Record<string, { balance: number; currency: string; status: number; type: string }> = {};
        const updatedClientAccounts: Record<string, {
            loginid: string; token: string; currency: string; account_type: string; balance: number
        }> = {};
        const updatedRestAccounts: Record<string, { balance: number; currency: string; type: string }> = {};

        let activeBalance = '0';
        let activeCurrency = 'USD';

        for (const acct of rawList) {
            const id = (acct.account_id ?? acct.id ?? acct.loginid ?? '') as string;
            const cur = (acct.currency ?? acct.account_currency ?? 'USD') as string;
            const bal = Number(acct.balance ?? 0) || 0;
            const atype = (acct.account_type ?? acct.type ?? 'real') as string;
            if (!id) continue;

            allAccounts[id] = { balance: bal, currency: cur, status: 1, type: atype };
            updatedClientAccounts[id] = {
                loginid: id, token: accessToken, currency: cur,
                account_type: atype, balance: bal,
            };
            updatedRestAccounts[id] = { balance: bal, currency: cur, type: atype };

            if (id === activeLoginId) {
                const decimals = cur === 'JPY' ? 0 : 2;
                activeBalance = bal.toFixed(decimals);
                activeCurrency = cur;
            }
        }

        // Merge — never wipe accounts not present in this response
        const existingClientAccounts = (() => {
            try { return JSON.parse(localStorage.getItem('clientAccounts') ?? '{}'); } catch { return {}; }
        })();
        localStorage.setItem('clientAccounts', JSON.stringify({ ...existingClientAccounts, ...updatedClientAccounts }));
        localStorage.setItem('restAccounts', JSON.stringify(updatedRestAccounts));

        console.log('[balance-refresh] Refreshed balances for:', Object.keys(allAccounts).join(', '));
        return { activeBalance, activeCurrency, allAccounts };
    } catch (err) {
        console.warn('[balance-refresh] Failed:', (err as Error).message);
        return null;
    }
}

/**
 * Read the cached balance for a given loginId from localStorage (clientAccounts).
 * Used for instant UI update before the REST call comes back.
 */
export function getCachedBalance(loginId: string): { balance: string; currency: string } | null {
    try {
        const raw = localStorage.getItem('clientAccounts');
        if (!raw) return null;
        const accounts = JSON.parse(raw) as Record<string, { balance?: number; currency?: string }>;
        const acct = accounts[loginId];
        if (!acct) return null;
        const cur = acct.currency ?? 'USD';
        const bal = Number(acct.balance ?? 0);
        const decimals = cur === 'JPY' ? 0 : 2;
        return { balance: bal.toFixed(decimals), currency: cur };
    } catch {
        return null;
    }
}
