import React from 'react';
import { observer } from 'mobx-react-lite';
import Chart from './chart';
import './chart.scss';

interface ChartWrapperProps {
    prefix?: string;
    show_digits_stats: boolean;
}

/**
 * ChartWrapper — renders a single stable Chart instance.
 *
 * Previously keyed on `client.loginid`, which destroyed and recreated
 * the Chart (and its WebSocket subscriptions) on every account change.
 * Now uses a stable key equal to `prefix` so the Chart stays mounted;
 * MobX observables propagate account/symbol changes reactively instead.
 */
const ChartWrapper = observer(({ prefix = 'chart', show_digits_stats }: ChartWrapperProps) => {
    return <Chart key={prefix} show_digits_stats={show_digits_stats} />;
});

export default ChartWrapper;
