import { fireEvent, render, screen } from '@testing-library/react';
import Journal from '@/components/journal';
import Summary from '@/components/summary';
import Transactions from '@/components/transactions';
import BotMonitorDropdown from '../bot-monitor-dropdown';

/* Breakpoint state is mutable so both host variants can be exercised. */
const mockDeviceState = { isDesktop: true, isMobile: false, isTablet: false };

/* Only the pieces of the store the monitor is allowed to look at. Every mutator
   is a spy: the monitor must never start/stop a bot or write any record. */
const mockRunPanel = {
    is_stop_button_visible: true,
    onRunButtonClick: jest.fn(),
    onStopBotClick: jest.fn(),
    toggleDrawer: jest.fn(),
};
const mockTransactions = { recoverPendingContracts: jest.fn(), pushTransaction: jest.fn(), clear: jest.fn() };
const mockJournal = { pushMessage: jest.fn(), onError: jest.fn() };

jest.mock('@deriv-com/ui', () => ({ useDevice: () => mockDeviceState }));
jest.mock('@deriv/quill-icons/LabelPaired', () => ({ LabelPairedChevronDownSmRegularIcon: () => 'chevron' }));
jest.mock('@/hooks/useStore', () => ({
    useStore: () => ({ run_panel: mockRunPanel, transactions: mockTransactions, journal: mockJournal }),
}));
jest.mock('@/components/summary', () => ({
    __esModule: true,
    default: jest.fn(() => 'summary-stub'),
}));
jest.mock('@/components/transactions', () => ({
    __esModule: true,
    default: jest.fn(() => 'transactions-stub'),
}));
jest.mock('@/components/journal', () => ({
    __esModule: true,
    default: jest.fn(() => 'journal-stub'),
}));

const SummaryMock = Summary as unknown as jest.Mock;
const TransactionsMock = Transactions as unknown as jest.Mock;
const JournalMock = Journal as unknown as jest.Mock;

const getToggle = () => screen.getByTestId('dt_bot_monitor_toggle');

describe('<BotMonitorDropdown />', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDeviceState.isDesktop = true;
        mockDeviceState.isMobile = false;
        mockRunPanel.is_stop_button_visible = true;
    });

    it('renders collapsed as a tiny arrow only (no panel, no child mounts)', () => {
        render(<BotMonitorDropdown />);

        expect(getToggle()).toBeInTheDocument();
        expect(getToggle()).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByTestId('dt_bot_monitor_panel')).not.toBeInTheDocument();
        expect(SummaryMock).not.toHaveBeenCalled();
        expect(TransactionsMock).not.toHaveBeenCalled();
        expect(JournalMock).not.toHaveBeenCalled();
    });

    it('opens on click and shows the existing Summary component by default', () => {
        render(<BotMonitorDropdown />);
        fireEvent.click(getToggle());

        expect(screen.getByTestId('dt_bot_monitor_panel')).toBeInTheDocument();
        expect(getToggle()).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByText('summary-stub')).toBeInTheDocument();
        expect(screen.queryByText('transactions-stub')).not.toBeInTheDocument();
        expect(SummaryMock).toHaveBeenCalledTimes(1);
        // Reuses the existing Summary with a collapsed drawer state.
        expect(SummaryMock.mock.calls[0][0]).toEqual({ is_drawer_open: false });
    });

    it('switches between the existing Transactions and Journal components', () => {
        render(<BotMonitorDropdown />);
        fireEvent.click(getToggle());

        fireEvent.click(screen.getByTestId('dt_bot_monitor_tab_transactions'));
        expect(screen.getByText('transactions-stub')).toBeInTheDocument();
        expect(TransactionsMock.mock.calls[0][0]).toEqual({ is_drawer_open: false });

        fireEvent.click(screen.getByTestId('dt_bot_monitor_tab_journal'));
        expect(screen.getByText('journal-stub')).toBeInTheDocument();
        expect(JournalMock).toHaveBeenCalledTimes(1);
    });

    it('collapses back to the arrow and unmounts the reused components', () => {
        render(<BotMonitorDropdown />);

        fireEvent.click(getToggle());
        expect(SummaryMock).toHaveBeenCalledTimes(1);
        expect(screen.getByText('summary-stub')).toBeInTheDocument();

        fireEvent.click(getToggle());
        expect(screen.queryByTestId('dt_bot_monitor_panel')).not.toBeInTheDocument();
        expect(screen.queryByText('summary-stub')).not.toBeInTheDocument();
        expect(SummaryMock).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape and on an outside click', () => {
        render(<BotMonitorDropdown />);

        fireEvent.click(getToggle());
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('dt_bot_monitor_panel')).not.toBeInTheDocument();

        fireEvent.click(getToggle());
        expect(screen.getByTestId('dt_bot_monitor_panel')).toBeInTheDocument();
        fireEvent.mouseDown(document.body);
        expect(screen.queryByTestId('dt_bot_monitor_panel')).not.toBeInTheDocument();
    });

    it('never mutates the stores it monitors', () => {
        render(<BotMonitorDropdown />);
        fireEvent.click(getToggle());
        fireEvent.click(screen.getByTestId('dt_bot_monitor_tab_journal'));
        fireEvent.click(getToggle());

        [
            mockRunPanel.onRunButtonClick,
            mockRunPanel.onStopBotClick,
            mockRunPanel.toggleDrawer,
            mockTransactions.recoverPendingContracts,
            mockTransactions.pushTransaction,
            mockTransactions.clear,
            mockJournal.pushMessage,
            mockJournal.onError,
        ].forEach(spy => expect(spy).not.toHaveBeenCalled());
    });

    it('stays available after the bot stops (arrow always visible, last-known data kept)', () => {
        mockRunPanel.is_stop_button_visible = false;
        render(<BotMonitorDropdown />);

        const toggle = getToggle();
        expect(toggle).toBeInTheDocument();
        expect(toggle).not.toHaveClass('bot-monitor__toggle--running');

        fireEvent.click(toggle);
        expect(screen.getByTestId('dt_bot_monitor_panel')).toBeInTheDocument();
        expect(screen.getByText('summary-stub')).toBeInTheDocument();
    });

    describe('variant gating (exactly one monitor per breakpoint)', () => {
        it('renders the mobile variant only on mobile widths', () => {
            mockDeviceState.isMobile = true;
            const { unmount } = render(<BotMonitorDropdown variant='mobile-controls' />);
            expect(getToggle()).toBeInTheDocument();
            unmount();

            mockDeviceState.isMobile = false;
            render(<BotMonitorDropdown variant='mobile-controls' />);
            expect(screen.queryByTestId('dt_bot_monitor_toggle')).not.toBeInTheDocument();
        });

        it('renders the status-bar variant only on wider widths', () => {
            mockDeviceState.isMobile = false;
            const { unmount } = render(<BotMonitorDropdown variant='status-bar' />);
            expect(getToggle()).toBeInTheDocument();
            unmount();

            mockDeviceState.isMobile = true;
            render(<BotMonitorDropdown variant='status-bar' />);
            expect(screen.queryByTestId('dt_bot_monitor_toggle')).not.toBeInTheDocument();
        });
    });
});
