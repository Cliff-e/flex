import {
    fillMissingBalances,
    isBalanceMessageRelevant,
    mergeBalanceAccounts,
    seedAuthorizeBalance,
} from '../balance-guard';

describe('isBalanceMessageRelevant', () => {
    it('rejects when not authorized', () => {
        expect(isBalanceMessageRelevant({ loginid: 'VRTC1', balance: 10000 }, 'VRTC1', false)).toBe(false);
    });

    it('rejects a balance push for a different loginid', () => {
        expect(isBalanceMessageRelevant({ loginid: 'VRTC2', balance: 10000 }, 'VRTC1', true)).toBe(false);
    });

    it('accepts a push for the active account', () => {
        expect(isBalanceMessageRelevant({ loginid: 'VRTC1', balance: 10000 }, 'VRTC1', true)).toBe(true);
    });

    it('rejects undefined balance payloads', () => {
        expect(isBalanceMessageRelevant(undefined, 'VRTC1', true)).toBe(false);
    });
});

describe('mergeBalanceAccounts', () => {
    it('merges an accounts map without dropping existing entries', () => {
        const result = mergeBalanceAccounts(
            { accounts: { VRTC1: { balance: 100, currency: 'USD' }, CR1: { balance: 50, currency: 'USD' } } },
            { accounts: { VRTC2: { balance: 9999, currency: 'USD' } } }
        );

        expect(result.accounts.VRTC1.balance).toBe(100);
        expect(result.accounts.CR1.balance).toBe(50);
        expect(result.accounts.VRTC2.balance).toBe(9999);
    });

    it('updates a single account balance by loginid', () => {
        const result = mergeBalanceAccounts(
            { accounts: { VRTC1: { balance: 100, currency: 'USD' } } },
            { loginid: 'VRTC1', balance: 10000, currency: 'USD' }
        );

        expect(result.accounts.VRTC1.balance).toBe(10000);
    });

    it('returns an empty map when there is nothing to merge', () => {
        const result = mergeBalanceAccounts(null, {});
        expect(result.accounts).toEqual({});
    });
});

describe('seedAuthorizeBalance', () => {
    it('seeds the authorize balance under its own loginid', () => {
        const result = seedAuthorizeBalance(
            { accounts: { CR1: { balance: 10, currency: 'USD' } } },
            { loginid: 'CR2', balance: 250.5, currency: 'EUR' }
        );

        expect(result?.accounts.CR1.balance).toBe(10);
        expect(result?.accounts.CR2.balance).toBe(250.5);
        expect(result?.accounts.CR2.currency).toBe('EUR');
    });

    it('rejects payloads without a loginid or a finite balance', () => {
        expect(seedAuthorizeBalance(null, { balance: 100 })).toBeNull();
        expect(seedAuthorizeBalance(null, { loginid: 'CR1' })).toBeNull();
        expect(seedAuthorizeBalance(null, { loginid: 'CR1', balance: Number.NaN })).toBeNull();
    });
});

describe('fillMissingBalances', () => {
    it('fills only accounts missing from the live map', () => {
        const existing = { accounts: { CR1: { balance: 75, currency: 'USD' } } };
        const result = fillMissingBalances(existing, {
            CR1: { balance: 50, currency: 'USD' },
            CR2: { balance: 100, currency: 'USD' },
        });

        expect(result?.accounts.CR1.balance).toBe(75);
        expect(result?.accounts.CR2.balance).toBe(100);
    });

    it('returns the existing reference when nothing needs to be added', () => {
        const existing = { accounts: { CR1: { balance: 75, currency: 'USD' } } };
        expect(fillMissingBalances(existing, { CR1: { balance: 50, currency: 'USD' } })).toBe(existing);
    });
});
