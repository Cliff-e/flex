import React, { useMemo } from 'react';
import { TradeRecord } from '../../bot/tradingEngine';

type Props = { history: TradeRecord[] };

const DigitHeatmap: React.FC<Props> = ({ history }) => {
    const data = useMemo(() => {
        return Array.from({ length: 10 }, (_, d) => {
            const trades = history.filter(t => t.exitDigit === d);
            const wins = trades.filter(t => t.won).length;
            const losses = trades.length - wins;
            const pnl = trades.reduce((a, t) => a + t.profit, 0);
            return { digit: d, total: trades.length, wins, losses, pnl };
        });
    }, [history]);

    const maxCount = Math.max(...data.map(d => d.total), 1);

    if (history.length === 0) {
        return (
            <div style={S.wrap}>
                <div style={S.header}>Exit Digit Frequency Heatmap</div>
                <div style={S.empty}>No trades yet — heatmap appears once trading starts</div>
            </div>
        );
    }

    return (
        <div style={S.wrap}>
            <div style={S.header}>Exit Digit Frequency Heatmap</div>
            <div style={S.grid}>
                {data.map(({ digit, total, wins, losses, pnl }) => {
                    const heightPct = total === 0 ? 0 : (total / maxCount) * 100;
                    const winRate = total === 0 ? 0 : wins / total;
                    const barColor = total === 0 ? '#1a1a1a'
                        : winRate >= 0.6 ? '#00cc55'
                        : winRate >= 0.5 ? '#77dd77'
                        : winRate >= 0.4 ? '#ff9900'
                        : '#ff3333';

                    return (
                        <div key={digit} style={S.col}>
                            {/* count label */}
                            <span style={{ ...S.countLabel, color: total === 0 ? '#333' : '#aaa' }}>
                                {total}
                            </span>

                            {/* bar */}
                            <div style={S.barTrack}>
                                <div style={{
                                    ...S.bar,
                                    height: `${heightPct}%`,
                                    background: barColor,
                                    boxShadow: total > 0 ? `0 0 8px ${barColor}55` : 'none',
                                }} />
                            </div>

                            {/* digit label */}
                            <div style={{
                                ...S.digitLabel,
                                color: barColor,
                                borderColor: total > 0 ? barColor : '#222',
                                background: total > 0 ? `${barColor}15` : '#111',
                            }}>
                                {digit}
                            </div>

                            {/* win / loss */}
                            {total > 0 && (
                                <div style={S.wl}>
                                    <span style={{ color: '#00ff66' }}>{wins}W</span>
                                    <span style={{ color: '#ff4444' }}>{losses}L</span>
                                </div>
                            )}
                            {total === 0 && (
                                <div style={S.wl}>
                                    <span style={{ color: '#2a2a2a' }}>—</span>
                                </div>
                            )}

                            {/* p&l */}
                            {total > 0 && (
                                <span style={{ ...S.pnl, color: pnl >= 0 ? '#00ff66' : '#ff4444' }}>
                                    {pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* legend */}
            <div style={S.legend}>
                <span><span style={{ color: '#00cc55' }}>■</span> ≥60% win</span>
                <span><span style={{ color: '#77dd77' }}>■</span> 50–59%</span>
                <span><span style={{ color: '#ff9900' }}>■</span> 40–49%</span>
                <span><span style={{ color: '#ff3333' }}>■</span> &lt;40%</span>
            </div>
        </div>
    );
};

export default DigitHeatmap;

const S: Record<string, React.CSSProperties> = {
    wrap: {
        background: '#111',
        border: '1px solid #1e1e1e',
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
    },
    header: {
        fontSize: 10,
        color: '#444',
        textTransform: 'uppercase',
        letterSpacing: 1.5,
        fontFamily: 'monospace',
    },
    empty: {
        fontSize: 11,
        color: '#333',
        padding: '16px 0',
        textAlign: 'center',
        fontFamily: 'monospace',
    },
    grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(10, 1fr)',
        gap: 6,
        alignItems: 'end',
    },
    col: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
    },
    countLabel: {
        fontSize: 9,
        fontFamily: 'monospace',
        height: 14,
    },
    barTrack: {
        width: '100%',
        height: 80,
        background: '#0d0d0d',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'flex-end',
        overflow: 'hidden',
    },
    bar: {
        width: '100%',
        borderRadius: 4,
        transition: 'height 0.4s ease',
        minHeight: 2,
    },
    digitLabel: {
        width: 26,
        height: 26,
        borderRadius: '50%',
        border: '2px solid',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 700,
        fontFamily: 'monospace',
    },
    wl: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        fontSize: 9,
        fontFamily: 'monospace',
    },
    pnl: {
        fontSize: 8,
        fontFamily: 'monospace',
        fontWeight: 700,
    },
    legend: {
        display: 'flex',
        gap: 14,
        justifyContent: 'center',
        fontSize: 10,
        color: '#555',
        fontFamily: 'monospace',
        flexWrap: 'wrap',
    },
};
