import { buildStoredAccountList } from '../account-list';

describe('buildStoredAccountList', () => {
    it('returns the persisted authorised accounts without exposing tokens', () => {
        const accounts = buildStoredAccountList({
            clientAccounts: {
                CR123: { loginid: 'CR123', token: 'secret-token', currency: 'USD', account_type: 'real', balance: 25 },
                DOT90004580: {
                    loginid: 'DOT90004580',
                    token: 'demo-token',
                    currency: 'USD',
                    account_type: 'demo',
                    balance: 10000,
                },
            },
        });

        expect(accounts).toHaveLength(2);
        expect(accounts[0].loginid).toBe('CR123');
        expect(accounts[0].is_virtual).toBe(0);
        expect(accounts[1].loginid).toBe('DOT90004580');
        expect(accounts[1].is_virtual).toBe(1);
        accounts.forEach(account => expect(account).not.toHaveProperty('token'));
    });

    it('fills a missing balance from the restAccounts snapshot', () => {
        const [account] = buildStoredAccountList({
            clientAccounts: { CR123: { loginid: 'CR123', currency: 'USD', account_type: 'real' } },
            restAccounts: { CR123: { balance: 88.5, currency: 'USD' } },
        });

        expect((account as { balance?: number }).balance).toBe(88.5);
    });

    it('includes loginids present in accountsList but absent from clientAccounts', () => {
        const accounts = buildStoredAccountList({
            clientAccounts: {},
            accountsList: { CR999: 'token' },
        });

        expect(accounts).toHaveLength(1);
        expect(accounts[0].loginid).toBe('CR999');
        expect(accounts[0].currency).toBe('USD');
    });

    it('handles missing sources without throwing', () => {
        expect(buildStoredAccountList({})).toEqual([]);
        expect(buildStoredAccountList({ clientAccounts: null, accountsList: null, restAccounts: null })).toEqual([]);
    });
});
