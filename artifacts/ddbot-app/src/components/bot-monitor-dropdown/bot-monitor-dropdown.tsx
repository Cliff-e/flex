import React from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import Journal from '@/components/journal';
import Summary from '@/components/summary';
import Transactions from '@/components/transactions';
import { useStore } from '@/hooks/useStore';
import { LabelPairedChevronDownSmRegularIcon } from '@deriv/quill-icons/LabelPaired';
import { Localize, localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';

/**
 * Tiny collapsible bot monitor that sits next to the existing
 * "Contract bought / Contract closed" status indicator, so the status row reads
 * [Run/Stop] [contract status] [chevron].
 *
 * This component is deliberately a pure view layer:
 *  - it only reads the existing `run_panel` state,
 *  - it renders the existing Summary / Transactions / Journal components as-is,
 *  - it never starts/stops the bot, opens a socket or writes to a store, so no
 *    duplicate runtime, trade, journal entry or WS subscription can appear.
 *
 * Because it lives in the persistent status areas (the top-right
 * `.main__run-strategy-wrapper` rendered by pages/main, and the mobile
 * `.controls__section` bar rendered by the run panel), it stays available while
 * the bot keeps running on any tab (Bot Builder, D Circles, Charts, AI Bots,
 * Analysis Tool, Deep Trader, ...).
 */

type TMonitorTab = 'summary' | 'transactions' | 'journal';

type TBotMonitorDropdown = {
    /**
     * `status-bar`      - desktop/tablet top-right status area (viewport > 600px).
     * `mobile-controls` - mobile bottom controls bar (viewport <= 600px).
     *
     * Only the variant matching the current breakpoint renders, so exactly one
     * monitor exists at any width.
     */
    variant?: 'status-bar' | 'mobile-controls';
};

const MONITOR_TABS: Array<{ id: TMonitorTab; label: string }> = [
    { id: 'summary', label: 'Summary' },
    { id: 'transactions', label: 'Transactions' },
    { id: 'journal', label: 'Journal' },
];

const BotMonitorDropdown = observer(({ variant = 'status-bar' }: TBotMonitorDropdown) => {
    const { isMobile } = useDevice();
    const { run_panel } = useStore();
    const { is_stop_button_visible } = run_panel;

    const [is_open, setIsOpen] = React.useState(false);
    const [active_tab, setActiveTab] = React.useState<TMonitorTab>('summary');
    const container_ref = React.useRef<HTMLDivElement>(null);

    // The status areas host a single monitor per breakpoint.
    const is_variant_visible = variant === 'mobile-controls' ? isMobile : !isMobile;

    React.useEffect(() => {
        if (!is_open) return undefined;

        const closeOnOutsideInteraction = (event: MouseEvent | TouchEvent) => {
            const target = event.target as Node | null;
            if (target && container_ref.current?.contains(target)) return;
            setIsOpen(false);
        };

        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsOpen(false);
        };

        document.addEventListener('mousedown', closeOnOutsideInteraction);
        document.addEventListener('touchstart', closeOnOutsideInteraction);
        document.addEventListener('keydown', closeOnEscape);

        return () => {
            document.removeEventListener('mousedown', closeOnOutsideInteraction);
            document.removeEventListener('touchstart', closeOnOutsideInteraction);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [is_open]);

    if (!is_variant_visible) return null;

    return (
        <div className={classNames('bot-monitor', `bot-monitor--${variant}`)} ref={container_ref}>
            <button
                type='button'
                className={classNames('bot-monitor__toggle', {
                    'bot-monitor__toggle--open': is_open,
                    'bot-monitor__toggle--running': is_stop_button_visible,
                })}
                aria-expanded={is_open}
                aria-label={localize('Bot monitoring')}
                title={localize('Bot monitoring')}
                data-testid='dt_bot_monitor_toggle'
                onClick={() => setIsOpen(open => !open)}
            >
                <LabelPairedChevronDownSmRegularIcon className='bot-monitor__toggle-icon' fill='currentColor' />
            </button>
            {is_open && (
                <div
                    className='bot-monitor__panel'
                    role='dialog'
                    aria-label={localize('Bot monitoring')}
                    data-testid='dt_bot_monitor_panel'
                >
                    <div className='bot-monitor__tabs' role='tablist'>
                        {MONITOR_TABS.map(tab => (
                            <button
                                key={tab.id}
                                type='button'
                                role='tab'
                                aria-selected={active_tab === tab.id}
                                className={classNames('bot-monitor__tab', {
                                    'bot-monitor__tab--active': active_tab === tab.id,
                                })}
                                data-testid={`dt_bot_monitor_tab_${tab.id}`}
                                onClick={() => setActiveTab(tab.id)}
                            >
                                <Localize i18n_default_text={tab.label} />
                            </button>
                        ))}
                    </div>
                    <div className='bot-monitor__body' data-testid='dt_bot_monitor_body'>
                        {/* Reuse of the very same stores/components as Bot Builder - no copies. */}
                        {active_tab === 'summary' && <Summary is_drawer_open={false} />}
                        {active_tab === 'transactions' && <Transactions is_drawer_open={false} />}
                        {active_tab === 'journal' && <Journal />}
                    </div>
                </div>
            )}
        </div>
    );
});

export default BotMonitorDropdown;
