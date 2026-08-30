import JournalStore from '../journal-store';
import { subscribeToVHTransactions } from '../../bot/virtualHook/VHRuntime';

jest.mock('@/components/shared', () => ({
    formatDate: jest.fn((value: unknown) => String(value ?? '')),
}));

jest.mock('@/external/bot-skeleton', () => ({
    LogTypes: { WELCOME: 'WELCOME', WELCOME_BACK: 'WELCOME_BACK' },
    MessageTypes: { ERROR: 'ERROR', NOTIFY: 'NOTIFY', SUCCESS: 'SUCCESS' },
}));

jest.mock('@/external/bot-skeleton/constants/config', () => ({
    config: jest.fn(() => ({ lists: { NOTIFICATION_SOUND: [['silent', 'silent']] } })),
}));

jest.mock('@deriv-com/translations', () => ({
    localize: jest.fn((value: string) => value),
}));

jest.mock('../../utils/journal-notifications', () => ({
    isCustomJournalMessage: jest.fn(() => false),
}));

jest.mock('../../utils/session-storage', () => ({
    getStoredItemsByKey: jest.fn(() => ({})),
    getStoredItemsByUser: jest.fn(() => []),
    setStoredItemsByKey: jest.fn(),
}));

jest.mock('../../utils/settings', () => ({
    getSetting: jest.fn(() => null),
    storeSetting: jest.fn(),
}));

jest.mock('../../bot/virtualHook/VHRuntime', () => ({
    subscribeToVHTransactions: jest.fn(() => jest.fn()),
}));

jest.mock('../root-store', () => ({
    __esModule: true,
    default: class RootStore {},
}));

describe('JournalStore VH bridge', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('handles a detached VH commit callback with the JournalStore context intact', () => {
        let commitListener: ((record: any) => void) | undefined;
        (subscribeToVHTransactions as jest.Mock).mockImplementation((listener: (record: any) => void) => {
            commitListener = listener;
            return jest.fn();
        });

        const core: any = {
            client: {
                loginid: 'VRTC123',
                account_list: [{ loginid: 'VRTC123', is_virtual: true }],
            },
            common: { server_time: { get: () => new Date(0) } },
        };
        const rootStore: any = { core, run_panel: {}, dbot: {} };
        const journal = new JournalStore(rootStore, core);

        expect(commitListener).toBeDefined();
        commitListener!({
            contractId: 'vh-bridge-1',
            contractType: 'DIGITOVER',
            symbol: 'R_100',
            won: true,
            profit: 1,
        });

        expect(journal.unfiltered_messages[0].message).toBe(
            'Virtual Hook — virtual won — DIGITOVER — R_100'
        );
        expect(journal.unfiltered_messages[0].extra.profit).toBe(1);
    });
});