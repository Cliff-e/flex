/**
 * Execution-speed toggle UI (components/trade-animation).
 *
 * TradeAnimation is the only component that renders the Run/Stop button, and it is
 * reused by both layouts:
 *   - desktop: pages/dashboard/run-strategy.tsx (className toolbar__animation)
 *   - mobile:  components/run-panel MobileDrawerFooter (className controls__animation)
 *
 * One implementation therefore covers PC and phone; these tests render BOTH call
 * shapes and assert the visible states required by the spec (NORMAL = off,
 * FAST = on) plus the run-time lock.
 */

const toggleExecutionMode = jest.fn();

const mockStores: any = {};

jest.mock(
    '@/hooks/useStore',
    () => ({
        useStore: () => mockStores,
    })
);

// '@deriv-com/ui' ships ESM that jest cannot requireActual in this setup, and the
// component only needs useDevice from it.
jest.mock('@deriv-com/ui', () => ({
    useDevice: () => ({ isMobile: false, isDesktop: true, isTablet: false }),
}));

jest.mock('@deriv/quill-icons/LabelPaired', () => ({
    LabelPairedPlayLgFillIcon: () => null,
    LabelPairedSquareLgFillIcon: () => null,
}));

jest.mock('@/hooks/useApiBase', () => ({ useApiBase: () => ({ isAuthorizing: false, isAuthorized: true }) }));
jest.mock('@/components/contract-result-overlay', () => ({ __esModule: true, default: () => null }));
jest.mock('@/utils/ChartDataLayer', () => ({ ChartDataLayer: { mode: 'live' } }));
jest.mock('@/utils/EventBus', () => ({ EventBus: { on: jest.fn(() => () => {}) } }));
jest.mock('@/utils/pkce', () => ({ initiateDerivAuth: jest.fn() }));
jest.mock('../../../analytics/rudderstack-common-events', () => ({ rudderStackSendRunBotEvent: jest.fn() }));

jest.mock(
    '../../shared_ui/button',
    () => ({
        __esModule: true,
        default: ({ children, ...rest }: any) =>
            jest.requireActual('react').createElement('button', rest, children),
    })
);
jest.mock('../../shared_ui/tooltip/tooltip', () => ({ __esModule: true, default: () => null }));
jest.mock('../circular-wrapper', () => ({ __esModule: true, default: () => null }));
jest.mock('../contract-stage-text', () => ({ __esModule: true, default: () => null }));

import { fireEvent, render, screen } from '@testing-library/react';
import TradeAnimation from '../trade-animation';

const buildStores = (runPanelOverrides: Record<string, unknown> = {}) => {
    mockStores.run_panel = {
        contract_stage: 0,
        execution_mode: 'NORMAL',
        is_stop_button_disabled: false,
        is_stop_button_visible: false,
        onRunButtonClick: jest.fn(),
        onStopBotClick: jest.fn(),
        performSelfExclusionCheck: jest.fn(),
        toggleExecutionMode,
        ...runPanelOverrides,
    };
    mockStores.dashboard = { active_tab: 1, active_tour: '' };
    mockStores.summary_card = { is_contract_completed: false, profit: 0 };
    mockStores.blockly_store = {
        checkForSavedBots: jest.fn(() => Promise.resolve()),
        has_active_bot: true,
        has_saved_bots: true,
    };
    mockStores.client = { account_status: {}, is_logged_in: true, loginid: 'VRTC0000' };
    mockStores.load_modal = { dashboard_strategies: [], is_delete_modal_open: false };
};

beforeEach(() => {
    jest.clearAllMocks();
    buildStores();
});

const speedToggle = () => screen.getByTestId('dt_execution_speed_toggle');

describe('execution speed toggle', () => {
    test('renders NORMAL (off) beside the Run button by default', () => {
        render(<TradeAnimation className='toolbar__animation' />);

        expect(speedToggle()).toHaveTextContent('NORMAL');
        expect(speedToggle()).toHaveAttribute('aria-pressed', 'false');
        expect(document.querySelector('#db-animation__run-button')).not.toBeNull();
    });

    test('renders FAST (on) when the store mode is FAST', () => {
        buildStores({ execution_mode: 'FAST' });
        render(<TradeAnimation className='toolbar__animation' />);

        expect(speedToggle()).toHaveTextContent('FAST');
        expect(speedToggle()).toHaveAttribute('aria-pressed', 'true');
        expect(speedToggle().className).toContain('animation__speed-toggle--fast');
    });

    test('clicking the toggle flips the mode through the run panel store', () => {
        render(<TradeAnimation className='toolbar__animation' />);

        fireEvent.click(speedToggle());

        expect(toggleExecutionMode).toHaveBeenCalledTimes(1);
    });

    test('is locked while the bot is running (mode cannot change mid-run)', () => {
        buildStores({ is_stop_button_visible: true });
        render(<TradeAnimation className='toolbar__animation' />);

        expect(document.querySelector('#db-animation__stop-button')).not.toBeNull();
        expect(speedToggle()).toBeDisabled();
    });

    test('is rendered for both layout call sites (desktop toolbar and mobile controls)', () => {
        const desktop = render(<TradeAnimation className='toolbar__animation' />);
        expect(speedToggle()).toBeInTheDocument();
        desktop.unmount();

        const mobile = render(<TradeAnimation className='controls__animation' should_show_overlay />);
        expect(speedToggle()).toBeInTheDocument();
        expect(speedToggle()).toHaveTextContent('NORMAL');
        mobile.unmount();
    });
});