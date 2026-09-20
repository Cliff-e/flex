import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { LabelPairedChevronDownSmRegularIcon } from '@deriv/quill-icons/LabelPaired';
import { localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';

/**
 * Tiny show/hide arrow for the existing run-panel column, placed next to the
 * "Contract bought / Contract closed" status indicator:
 *
 *     [Run/Stop] [contract status] [arrow]
 *
 * It owns no state and renders no panel of its own. It flips the single existing
 * flag, `run_panel.is_drawer_open`, so this arrow and the drawer's own edge handle
 * can never disagree, and collapsing hides / opening reveals the whole column
 * exactly as before.
 *
 * The column keeps rendering the same Summary / Transactions / Journal /
 * Virtual Hook content, statistics and stores, so monitoring stays available while
 * the bot runs and the user is on another tab (D Circles, Charts, AI Bots,
 * Analysis Tool, Deep Trader, ...).
 */

type TBotMonitorDropdown = {
    /**
     * `status-bar`      - desktop/tablet top-right status area (viewport > 600px).
     * `mobile-controls` - mobile bottom controls bar (viewport <= 600px).
     *
     * Only the variant matching the current breakpoint renders, so exactly one
     * arrow exists at any width.
     */
    variant?: 'status-bar' | 'mobile-controls';
};

const BotMonitorDropdown = observer(({ variant = 'status-bar' }: TBotMonitorDropdown) => {
    const { isMobile } = useDevice();
    const { run_panel } = useStore();
    const { is_drawer_open, toggleDrawer } = run_panel;

    // The status areas host a single arrow per breakpoint.
    const is_variant_visible = variant === 'mobile-controls' ? isMobile : !isMobile;
    if (!is_variant_visible) return null;

    return (
        <button
            type='button'
            className={classNames('bot-monitor', `bot-monitor--${variant}`, {
                'bot-monitor--open': is_drawer_open,
            })}
            aria-expanded={is_drawer_open}
            aria-label={localize('Show or hide the bot monitoring panel')}
            title={localize('Show or hide the bot monitoring panel')}
            data-testid='dt_bot_monitor_toggle'
            onClick={() => toggleDrawer(!is_drawer_open)}
        >
            <LabelPairedChevronDownSmRegularIcon className='bot-monitor__icon' fill='currentColor' />
        </button>
    );
});

export default BotMonitorDropdown;
