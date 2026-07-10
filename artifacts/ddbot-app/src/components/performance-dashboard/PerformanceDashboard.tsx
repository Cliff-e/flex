import React, { useMemo } from 'react';
import { TradeRecord } from '../../bot/tradingEngine';

type Props = { history: TradeRecord[] };

// ── Cumulative P&L sparkline ──────────────────────────────────────────────────

const PnLChart: React.FC<{ history: TradeRecord[] }> = ({ history }) => {
    const W = 580;
    const H = 90;
    const PAD = 8;

    const points = useMemo(() => {
        let cum = 0;
        return [{ x: 0, y: 0 }].concat(
            history.map((t, i) => {
                cum += t.profit;
                return { x: i + 1, y: cum };
            })
        );
    }, [history]);

    if (history.length === 0) return (
        <div style={S.chartEmpty}>No trades yet — chart will appear once trading starts</div>
    );

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    const px = (x: number) => PAD + ((x - minX) / rangeX) * (W - PAD * 2);
    const py = (y: number) => PAD + ((maxY - y) / rangeY) * (H - PAD * 2);

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
    const areaPath = linePath + ` L${px(maxX).toFixed(1)},${py(0).toFixed(1)} L${px(0).toFixed(1)},${py(0).toFixed(1)} Z`;

    const lastProfit = points[points.length - 1].y;
    const lineColor = lastProfit >= 0 ? '#00ff66' : '#ff4444';
    const areaId = 'pnl-grad';

    return (
        <svg width='100%' viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
            <defs>
                <linearGradient id={areaId} x1='0' y1='0' x2='0' y2='1'>
                    <stop offset='0%' stopColor={lineColor} stopOpacity='0.18' />
                    <stop offset='100%' stopColor={lineColor} stopOpacity='0.01' />
                </linearGradient>
            </defs>
            {/* Zero baseline */}
            <line
                x1={PAD} y1={py(0).toFixed(1)}
                x2={W - PAD} y2={py(0).toFixed(1)}
                stroke='#2a2a2a' strokeWidth='1' strokeDasharray='3 3'
            />
            {/* Area fill */}
            <path d={areaPath} fill={`url(#${areaId})`} />
            {/* Line */}
            <path d={linePath} fill='none' stroke={lineColor} strokeWidth='1.5' strokeLinejoin='round' strokeLinecap='round' />
            {/* Last point dot */}
            <circle
                cx={px(points[points.length - 1].x)}
                cy={py(points[points.length - 1].y)}
                r='3' fill={lineColor}
            />
        </svg>
    );
};

// ── Win-rate ring ─────────────────────────────────────────────────────────────

const WinRateRing: React.FC<{ wins: number; total: number }> = ({ wins, total }) => {
    const pct = total === 0 ? 0 : wins / total;
    const r = 28;
    const circ = 2 * Math.PI * r;
    const dash = pct * circ;
    const color = pct >= 0.55 ? '#00ff66' : pct >= 0.45 ? '#ffa500' : '#ff4444';

    return (
        <div style={S.ringWrap}>
            <svg width={76} height={76} viewBox='0 0 76 76'>
                <circle cx={38} cy={38} r={r} fill='none' stroke='#1e1e1e' strokeWidth={8} />
                <circle
                    cx={38} cy={38} r={r}
                    fill='none' stroke={color} strokeWidth={8}
                    strokeDasharray={`${dash.toFixed(1)} ${(circ - dash).toFixed(1)}`}
                    strokeLinecap='round'
                    transform='rotate(-90 38 38)'
                />
                <text x={38} y={42} textAnchor='middle' fill={color} fontSize={13} fontWeight={700} fontFamily='monospace'>
                    {total === 0 ? '–' : `${Math.round(pct * 100)}%`}
                </text>
            </svg>
            <span style={{ ...S.ringLabel, color }}>Win Rate</span>
        </div>
    );
};

// ── Main dashboard ────────────────────────────────────────────────────────────

const PerformanceDashboard: React.FC<Props> = ({ history }) => {
    const stats = useMemo(() => {
        const wins = history.filter(t => t.won).length;
        const losses = history.length - wins;
        const profits = history.map(t => t.profit);
        const totalPnL = profits.reduce((a, b) => a + b, 0);
        const avgPnL = history.length ? totalPnL / history.length : 0;
        const bestWin = profits.length ? Math.max(...profits) : 0;
        const worstLoss = profits.length ? Math.min(...profits) : 0;

        let streak = 0;
        let bestStreak = 0;
        let worstStreak = 0;
        let curStreak = 0;
        let curSign = 0;

        history.forEach(t => {
            const sign = t.won ? 1 : -1;
            if (sign === curSign) {
                curStreak++;
            } else {
                curStreak = 1;
                curSign = sign;
            }
            if (t.won && curStreak > bestStreak) bestStreak = curStreak;
            if (!t.won && curStreak > worstStreak) worstStreak = curStreak;
        });

        return { wins, losses, totalPnL, avgPnL, bestWin, worstLoss, bestStreak, worstStreak };
    }, [history]);

    return (
        <div style={S.wrap}>
            <div style={S.header}>Performance Dashboard</div>

            {/* ── P&L Chart ── */}
            <div style={S.chartWrap}>
                <div style={S.chartTitle}>Cumulative P&amp;L</div>
                <PnLChart history={history} />
            </div>

            {/* ── Stats row ── */}
            <div style={S.statsRow}>
                <WinRateRing wins={stats.wins} total={history.length} />

                <div style={S.statsGrid}>
                    <StatCell label='Total Trades' value={String(history.length)} />
                    <StatCell label='Wins' value={String(stats.wins)} color='#00ff66' />
                    <StatCell label='Losses' value={String(stats.losses)} color='#ff4444' />
                    <StatCell
                        label='Avg P&L'
                        value={`${stats.avgPnL >= 0 ? '+' : ''}${stats.avgPnL.toFixed(2)}`}
                        color={stats.avgPnL >= 0 ? '#00ff66' : '#ff4444'}
                    />
                    <StatCell
                        label='Best Win'
                        value={`+${stats.bestWin.toFixed(2)}`}
                        color='#00ff66'
                    />
                    <StatCell
                        label='Worst Loss'
                        value={stats.worstLoss.toFixed(2)}
                        color='#ff4444'
                    />
                    <StatCell label='Best Streak' value={`${stats.bestStreak}W`} color='#00ff66' />
                    <StatCell label='Worst Streak' value={`${stats.worstStreak}L`} color='#ff4444' />
                </div>
            </div>
        </div>
    );
};

const StatCell: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color = '#e0e0e0' }) => (
    <div style={S.statCell}>
        <span style={S.statLabel}>{label}</span>
        <span style={{ ...S.statValue, color }}>{value}</span>
    </div>
);

export default PerformanceDashboard;

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
    wrap: {
        background: '#111',
        border: '1px solid #1e1e1e',
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
    },
    header: {
        fontSize: 10,
        color: '#444',
        textTransform: 'uppercase',
        letterSpacing: 1.5,
        fontFamily: 'monospace',
    },
    chartWrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
    },
    chartTitle: {
        fontSize: 10,
        color: '#333',
        textTransform: 'uppercase',
        letterSpacing: 1,
        fontFamily: 'monospace',
    },
    chartEmpty: {
        fontSize: 11,
        color: '#333',
        padding: '18px 0',
        textAlign: 'center',
        fontFamily: 'monospace',
    },
    statsRow: {
        display: 'flex',
        gap: 14,
        alignItems: 'center',
    },
    ringWrap: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        flexShrink: 0,
    },
    ringLabel: {
        fontSize: 9,
        textTransform: 'uppercase',
        letterSpacing: 1,
        fontFamily: 'monospace',
    },
    statsGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '8px 12px',
        flex: 1,
    },
    statCell: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
    },
    statLabel: {
        fontSize: 9,
        color: '#444',
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        fontFamily: 'monospace',
    },
    statValue: {
        fontSize: 13,
        fontWeight: 700,
        fontFamily: 'monospace',
    },
};
