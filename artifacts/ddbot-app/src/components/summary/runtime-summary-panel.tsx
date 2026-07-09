import { useEffect, useState } from 'react';
import classnames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { localize } from '@deriv-com/translations';
import './runtime-summary-panel.scss';

const formatDuration = (start_time: number | null): string => {
    if (!start_time) return '--';
    const seconds = Math.max(0, Math.floor((Date.now() - start_time) / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h, m, s].map(unit => String(unit).padStart(2, '0')).join(':');
};

const STATUS_LABELS: Record<string, string> = {
    idle: 'Idle',
    running: 'Running',
    paused: 'Paused',
    stopped: 'Stopped',
};

const RuntimeSummaryPanel = observer(() => {
    const { bot_runtime, client } = useStore();
    const { summary } = bot_runtime;
    const [, forceTick] = useState(0);

    useEffect(() => {
        if (summary.status !== 'running') return undefined;
        const interval = setInterval(() => forceTick(tick => tick + 1), 1000);
        return () => clearInterval(interval);
    }, [summary.status]);

    if (!summary.has_active_bot) return null;

    const net_profit_class = summary.net_profit > 0 ? 'positive' : summary.net_profit < 0 ? 'negative' : '';

    const tiles: Array<{ label: string; value: string; valueClass?: string }> = [
        { label: localize('Strategy'), value: summary.active_strategy },
        { label: localize('Market'), value: summary.market },
        { label: localize('Total trades'), value: String(summary.total_trades) },
        { label: localize('Wins'), value: String(summary.wins) },
        { label: localize('Losses'), value: String(summary.losses) },
        { label: localize('Win rate'), value: `${summary.win_rate.toFixed(1)}%` },
        { label: localize('Net P/L'), value: summary.net_profit.toFixed(2), valueClass: net_profit_class },
        { label: localize('Current signal'), value: summary.current_signal || '--' },
        { label: localize('Current position'), value: summary.current_position || '--' },
        { label: localize('Runtime'), value: formatDuration(summary.start_time) },
        { label: localize('Balance'), value: `${client.balance} ${client.currency}` },
    ];

    return (
        <div className='runtime-summary' data-testid='runtime-summary-panel'>
            <div className='runtime-summary__header'>
                <span className='runtime-summary__title'>{summary.bot_name || localize('Active bot')}</span>
                <span
                    className={classnames('runtime-summary__status', `runtime-summary__status--${summary.status}`)}
                >
                    {STATUS_LABELS[summary.status] ?? summary.status}
                </span>
            </div>
            <div className='runtime-summary__grid'>
                {tiles.map(tile => (
                    <div className='runtime-summary__tile' key={tile.label}>
                        <span className='runtime-summary__tile-label'>{tile.label}</span>
                        <span
                            className={classnames('runtime-summary__tile-value', {
                                [`runtime-summary__tile-value--${tile.valueClass}`]: !!tile.valueClass,
                            })}
                        >
                            {tile.value}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
});

export default RuntimeSummaryPanel;
