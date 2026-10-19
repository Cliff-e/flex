import { deriveIsVirtual, mergeAccountLists, normalizeAccount, normalizeAccountList, type RawAccount } from '../account-list';

describe('deriveIsVirtual', () => {
    it('classifies demo accounts from authoritative account_type metadata', () => {
        // A demo loginid that does NOT use the legacy VRT/VRW prefix.
        expect(deriveIsVirtual({ loginid: 'DOT90004580', account_type: 'demo' })).toBe(true);
        expect(deriveIsVirtual({ loginid: 'CR123', account_type: 'demo' })).toBe(true);
        expect(deriveIsVirtual({ loginid: 'VRTC123', account_type: 'virtual' })).toBe(true);
    });

    it('classifies real accounts from authoritative account_type metadata even with a VR prefix', () => {
        expect(deriveIsVirtual({ loginid: 'VRTC123', account_type: 'real' })).toBe(false);
        expect(deriveIsVirtual({ loginid: 'CR123', type: 'real' })).toBe(false);
    });

    it('falls back to is_virtual when no account type is supplied', () => {
        expect(deriveIsVirtual({ loginid: 'CR123', is_virtual: 1 })).toBe(true);
        expect(deriveIsVirtual({ loginid: 'VRTC123', is_virtual: 0 })).toBe(false);
    });

    it('falls back to the loginid prefix only when no metadata exists', () => {
        expect(deriveIsVirtual({ loginid: 'VRTC123' })).toBe(true);
        expect(deriveIsVirtual({ loginid: 'CR123' })).toBe(false);
    });
});

describe('normalizeAccountList', () => {
    it('maps REST account fields into the expected account_list shape', () => {
        const [account] = normalizeAccountList([
            {
                account_id: 'DOT90004580',
                currency: 'USD',
                balance: 10000,
                account_type: 'demo',
            },
        ]);

        expect(account.loginid).toBe('DOT90004580');
        expect(account.currency).toBe('USD');
        expect(account.is_virtual).toBe(1);
        expect(account.landing_company_name).toBe('virtual');
        expect((account as { balance?: number }).balance).toBe(10000);
    });

    it('keeps real accounts real and preserves their balance', () => {
        const [account] = normalizeAccountList([
            { account_id: 'CR123', account_currency: 'EUR', balance: '12.5', account_type: 'real' },
        ]);

        expect(account.loginid).toBe('CR123');
        expect(account.currency).toBe('EUR');
        expect(account.is_virtual).toBe(0);
        expect(account.landing_company_name).toBe('svg');
        expect((account as { balance?: number }).balance).toBe(12.5);
    });

    it('drops entries without a loginid', () => {
        expect(normalizeAccountList([{ currency: 'USD' }, { account_id: 'CR1', currency: 'USD' }])).toHaveLength(1);
    });

    it('does not fabricate a balance when the API did not provide one', () => {
        const account = normalizeAccount({ loginid: 'CR1', currency: 'USD', account_type: 'real' });
        expect(account).not.toBeNull();
        expect((account as { balance?: number }).balance).toBeUndefined();
    });

    it('marks accounts with is_disabled metadata as disabled', () => {
        const [account] = normalizeAccountList([
            { loginid: 'CR1', currency: 'USD', account_type: 'real', is_disabled: 1 },
        ]);
        expect(account.is_disabled).toBe(1);
    });
});

describe('mergeAccountLists', () => {
    const account = (loginid: string, extra: Partial<RawAccount> = {}) =>
        normalizeAccount({ loginid, currency: 'USD', account_type: 'real', ...extra })!;

    it('keeps every account from the REST snapshot when the WS list is partial', () => {
        const merged = mergeAccountLists([account('CR1')], [account('CR1'), account('DOT90004580')]);

        expect(merged.map(item => item.loginid)).toEqual(['CR1', 'DOT90004580']);
    });

    it('lets the WS entry win for a loginid present in both lists', () => {
        const merged = mergeAccountLists(
            [account('CR1', { currency: 'EUR' })],
            [account('CR1', { currency: 'USD' })]
        );

        expect(merged).toHaveLength(1);
        expect(merged[0].currency).toBe('EUR');
    });

    it('handles empty inputs', () => {
        expect(mergeAccountLists(null, null)).toEqual([]);
        expect(mergeAccountLists([account('CR1')], null)).toHaveLength(1);
    });
});
