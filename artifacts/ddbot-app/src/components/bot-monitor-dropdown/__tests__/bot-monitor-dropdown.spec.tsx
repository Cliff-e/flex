import { fireEvent, render, screen } from '@testing-library/react';
import BotMonitorDropdown from '../bot-monitor-dropdown';

/* Breakpoint state is mutable so both host variants can be exercised. */
const mockDeviceState = { isDesktop: true, isMobile: false, isTablet: false };

/* The run panel store: the arrow is only allowed to read `is_drawer_open` and call
   `toggleDrawer`. Everything else is spied on to prove nothing else is touched. */
const mockToggleDrawer = jest.fn();
const mockRunPanel = {
    is_drawer_open: true,
    toggleDrawer: mockToggleDrawer,
    onRunButtonClick: jest.fn(),
    onStopBotClick: jest.fn(),
    onClearStatClick: jest.fn(),
    onMount: jest.fn(),
    onUnmount: jest.fn(),
    setActiveTabIndex: jest.fn(),
    toggleStatisticsInfoModal: jest.fn(),
};

jest.mock('@deriv-com/ui', () => ({ useDevice: () => mockDeviceState }));
jest.mock('@deriv/quill-icons/LabelPaired', () => ({ LabelPairedChevronDownSmRegularIcon: () => 'chevron' }));
jest.mock('@/hooks/useStore', () => ({
    useStore: () => ({
        run_panel: mockRunPanel,
        transactions: { recoverPendingContracts: jest.fn(), clear: jest.fn() },
        journal: { pushMessage: jest.fn() },
        summary_card: { onBotContractEvent: jest.fn() },
    }),
}));

const getArrow = () => screen.getByTestId('dt_bot_monitor_toggle');

describe('<BotMonitorDropdown /> (show/hide arrow for the run-panel column)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDeviceState.isDesktop = true;
        mockDeviceState.isMobile = false;
        mockRunPanel.is_drawer_open = true;
    });

    it('renders only the tiny arrow - it never renders a panel of its own', () => {
        const { container } = render(<BotMonitorDropdown />);

        expect(getArrow()).toBeInTheDocument();
        // The only thing this component may render is the arrow button itself.
        expect(container.firstElementChild).toBe(getArrow());
        expect(getArrow().childNodes).toHaveLength(1);
        expect(container.querySelectorAll('button')).toHaveLength(1);
        // No duplicated monitor panel/tabs anywhere.
        expect(screen.queryByTestId('dt_bot_monitor_panel')).not.toBeInTheDocument();
        expect(screen.queryByText('Summary')).not.toBeInTheDocument();
        expect(screen.queryByText('Transactions')).not.toBeInTheDocument();
        expect(screen.queryByText('Journal')).not.toBeInTheDocument();
    });

    it('hides the whole column when it is open', () => {
        mockRunPanel.is_drawer_open = true;
        render(<BotMonitorDropdown />);

        expect(getArrow()).toHaveAttribute('aria-expanded', 'true');
        expect(getArrow()).toHaveClass('bot-monitor--open');

        fireEvent.click(getArrow());

        expect(mockToggleDrawer).toHaveBeenCalledTimes(1);
        expect(mockToggleDrawer).toHaveBeenCalledWith(false);
    });

    it('reveals the whole column when it is hidden', () => {
        mockRunPanel.is_drawer_open = false;
        render(<BotMonitorDropdown />);

        expect(getArrow()).toHaveAttribute('aria-expanded', 'false');
        expect(getArrow()).not.toHaveClass('bot-monitor--open');

        fireEvent.click(getArrow());

        expect(mockToggleDrawer).toHaveBeenCalledTimes(1);
        expect(mockToggleDrawer).toHaveBeenCalledWith(true);
    });

    it('reflects a column state changed elsewhere (drawer edge handle)', () => {
        mockRunPanel.is_drawer_open = false;
        const { unmount } = render(<BotMonitorDropdown />);
        expect(getArrow()).toHaveAttribute('aria-expanded', 'false');
        unmount();

        mockRunPanel.is_drawer_open = true;
        render(<BotMonitorDropdown />);

        expect(getArrow()).toHaveAttribute('aria-expanded', 'true');
        expect(getArrow()).toHaveClass('bot-monitor--open');
    });

    it('toggles on every click without holding its own state', () => {
        mockRunPanel.is_drawer_open = false;
        const { unmount } = render(<BotMonitorDropdown />);

        fireEvent.click(getArrow());
        expect(mockToggleDrawer).toHaveBeenLastCalledWith(true);
        unmount();

        mockRunPanel.is_drawer_open = true;
        render(<BotMonitorDropdown />);
        fireEvent.click(getArrow());
        expect(mockToggleDrawer).toHaveBeenLastCalledWith(false);

        expect(mockToggleDrawer).toHaveBeenCalledTimes(2);
    });

    it('never starts, stops or resets anything and never writes records', () => {
        render(<BotMonitorDropdown />);
        fireEvent.click(getArrow());

        [
            mockRunPanel.onRunButtonClick,
            mockRunPanel.onStopBotClick,
            mockRunPanel.onClearStatClick,
            mockRunPanel.onMount,
            mockRunPanel.onUnmount,
            mockRunPanel.setActiveTabIndex,
            mockRunPanel.toggleStatisticsInfoModal,
        ].forEach(spy => expect(spy).not.toHaveBeenCalled());
    });

    describe('variant gating (exactly one arrow per breakpoint)', () => {
        it('renders the mobile variant only on mobile widths', () => {
            mockDeviceState.isMobile = true;
            const { unmount } = render(<BotMonitorDropdown variant='mobile-controls' />);
            expect(getArrow()).toBeInTheDocument();
            unmount();

            mockDeviceState.isMobile = false;
            render(<BotMonitorDropdown variant='mobile-controls' />);
            expect(screen.queryByTestId('dt_bot_monitor_toggle')).not.toBeInTheDocument();
        });

        it('renders the status-bar variant only on wider widths', () => {
            mockDeviceState.isMobile = false;
            const { unmount } = render(<BotMonitorDropdown variant='status-bar' />);
            expect(getArrow()).toBeInTheDocument();
            unmount();

            mockDeviceState.isMobile = true;
            render(<BotMonitorDropdown variant='status-bar' />);
            expect(screen.queryByTestId('dt_bot_monitor_toggle')).not.toBeInTheDocument();
        });
    });
});
