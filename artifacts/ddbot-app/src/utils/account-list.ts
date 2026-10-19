/**
 * Account metadata normalisation.
 *
 * The new Deriv Options API (api.derivws.com) returns accounts from REST with
 * `account_id` / `account_type` fields, while the legacy WebSocket API used
 * `loginid` / `is_virtual`. Every consumer in the app expects the legacy
 * `TAuthData['account_list']` shape, so normalise at the boundary instead of
 * repeating (and subtly diverging) the mapping in each consumer.
 *
 * Real/Demo classification always prefers authoritative metadata
 * (`account_type` / `type` / `is_virtual`) and only falls back to the loginid
 * prefix when the API supplied no type information at all.
 */
import type { TAuthData } from '@/types/api-types';

export type RawAccount = {
    account_id?: string;
    id?: string;
    loginid?: string;
    /** Present in the persisted clientAccounts map; never copied to output. */
    token?: string;
    currency?: string;
    account_currency?: string;
    balance?: number | string | null;
    account_type?: string;
    type?: string;
    is_virtual?: number | boolean | string;
    is_disabled?: number | boolean | string;
    landing_company_name?: string;
    landing_company_shortcode?: string;
};

const DEMO_ACCOUNT_TYPES = new Set(['demo', 'virtual']);

const toBoolean = (value: unknown): boolean | undefined => {
    if (value === true || value === 1 || value === '1' || value === 'true') return true;
    if (value === false || value === 0 || value === '0' || value === 'false') return false;
    return undefined;
};

export const getAccountLoginid = (raw: RawAccount): string =>
    String(raw.loginid ?? raw.account_id ?? raw.id ?? '').trim();

/**
 * Resolve whether an account is a Demo (virtual) account.
 *
 * Priority:
 *   1. account_type / type — authoritative REST metadata
 *   2. is_virtual          — legacy WebSocket metadata
 *   3. VRT/VRW prefix      — last-resort heuristic only
 */
export const deriveIsVirtual = (raw: RawAccount): boolean => {
    const accountType = String(raw.account_type ?? raw.type ?? '')
        .trim()
        .toLowerCase();

    if (DEMO_ACCOUNT_TYPES.has(accountType)) return true;
    if (accountType === 'real') return false;

    const explicit = toBoolean(raw.is_virtual);
    if (explicit !== undefined) return explicit;

    return /^(VRT|VRW)/i.test(getAccountLoginid(raw));
};

/**
 * Convert a single raw REST/WS account into the app's account_list shape.
 * Returns null for entries without a usable loginid.
 */
export const normalizeAccount = (raw: RawAccount): TAuthData['account_list'][number] | null => {
    const loginid = getAccountLoginid(raw);
    if (!loginid) return null;

    const isVirtual = deriveIsVirtual({ ...raw, loginid });
    const currency = String(raw.currency ?? raw.account_currency ?? 'USD') || 'USD';
    const balanceNumber = raw.balance === null || raw.balance === undefined ? NaN : Number(raw.balance);
    const isDisabled = toBoolean(raw.is_disabled) ? 1 : 0;

    const account = {
        loginid,
        currency,
        is_virtual: isVirtual ? 1 : 0,
        is_disabled: isDisabled,
        account_type: isVirtual ? 'demo' : 'real',
        landing_company_name:
            raw.landing_company_name ?? raw.landing_company_shortcode ?? (isVirtual ? 'virtual' : 'svg'),
    } as Record<string, unknown>;

    // Keep the authoritative balance when the API returned one. It is used as
    // an immediate display value until the live WS balance subscription fires.
    if (Number.isFinite(balanceNumber)) {
        account.balance = balanceNumber;
    }

    return account as unknown as TAuthData['account_list'][number];
};

export const normalizeAccountList = (rawAccounts: readonly RawAccount[] | null | undefined): TAuthData['account_list'] =>
    (rawAccounts ?? []).reduce<TAuthData['account_list']>((accounts, raw) => {
        const account = normalizeAccount(raw);
        if (account) accounts.push(account);
        return accounts;
    }, []);

/**
 * Combines two normalised account lists. Entries from `primary` win; entries
 * only present in `fallback` are appended. Used to keep every account the REST
 * accounts endpoint reported visible even when the new trading API returns a
 * partial `authorize.account_list`.
 */
export const mergeAccountLists = (
    primary: TAuthData['account_list'] | null | undefined,
    fallback: TAuthData['account_list'] | null | undefined
): TAuthData['account_list'] => {
    const merged = [...(primary ?? [])];
    const known = new Set(merged.map(account => account.loginid));
    (fallback ?? []).forEach(account => {
        if (!known.has(account.loginid)) {
            merged.push(account);
            known.add(account.loginid);
        }
    });
    return merged;
};

export type StoredAccountSources = {
    clientAccounts?: Record<string, RawAccount> | null;
    accountsList?: Record<string, string> | null;
    restAccounts?: Record<string, RawAccount> | null;
};

/**
 * Builds the display account list from the metadata persisted at login:
 *
 *   clientAccounts — loginid → { currency, account_type, balance, ... }
 *   accountsList   — loginid → access token (used only to discover loginids
 *                    the REST payload omitted; tokens are never returned)
 *   restAccounts   — loginid → { balance, currency, type } (balance fallback)
 *
 * This is display-only metadata. It never decides whether the WS session is
 * authorized; callers must keep using AuthSessionManager.isAuthorized().
 */
export const buildStoredAccountList = ({
    clientAccounts,
    accountsList,
    restAccounts,
}: StoredAccountSources): TAuthData['account_list'] => {
    const records: RawAccount[] = [];

    if (clientAccounts && typeof clientAccounts === 'object') {
        Object.values(clientAccounts).forEach(account => {
            if (account && typeof account === 'object') records.push(account);
        });
    }

    const knownLoginids = new Set(records.map(getAccountLoginid).filter(Boolean));
    if (accountsList && typeof accountsList === 'object') {
        Object.keys(accountsList).forEach(loginid => {
            if (loginid && !knownLoginids.has(loginid)) {
                records.push({ loginid });
                knownLoginids.add(loginid);
            }
        });
    }

    // Fill balances/currencies the REST accounts response omitted. Live WS
    // balance pushes still take precedence downstream.
    records.forEach(record => {
        const loginid = getAccountLoginid(record);
        const cached = restAccounts?.[loginid];
        if (!cached) return;
        if (record.balance == null && cached.balance != null) record.balance = cached.balance;
        if (!record.currency && cached.currency) record.currency = cached.currency;
        if (!record.account_type && !record.type && cached.type) record.account_type = cached.type;
    });

    return normalizeAccountList(records);
};
