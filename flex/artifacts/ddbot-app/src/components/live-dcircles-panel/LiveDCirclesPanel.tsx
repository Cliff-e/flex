import React, { useEffect, useMemo, useRef, useState } from 'react';
import { dcirclesStore } from '../../bot/dcirclesStore';
import { analyzeSignals } from '../../pages/d-circles/signalEngine';
import { globalTickEngine } from '../../bot/globalTickEngine';

type Props = { symbol: string; isDark?: boolean };

const LiveDCirclesPanel: React.FC<Props> = ({ symbol, isDark = false }) => {
    const [digits, setDigits] = useState<number[]>(() => globalTickEngine.getDigits(symbol));
    const [tickLimit, setTickLimit] = useState(() => globalTickEngine.getLimit());
    const [limitInput, setLimitInput] = useState(() => String(globalTickEngine.getLimit()));
    const [isEditingLimit, setIsEditingLimit] = useState(false);
    const limitInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setDigits(globalTickEngine.getDigits(symbol));

        const unsub = globalTickEngine.subscribe((sym, d) => {
            if (sym === symbol) setDigits(d);
        });
        return unsub;
    }, [symbol]);

    // Keep input display in sync when limit is changed from another consumer
    useEffect(() => {
        const unsub = globalTickEngine.onLimitChange(n => {
            setTickLimit(n);
            if (!isEditingLimit) setLimitInput(String(n));
        });
        return unsub;
    }, [isEditingLimit]);

    // Sync input string when not editing
    useEffect(() => {
        if (!isEditingLimit) setLimitInput(String(tickLimit));
    }, [tickLimit, isEditingLimit]);

    // Publish to dcirclesStore so the bot engine can read it
    useEffect(() => {
        const total = digits.length || 1;
        const f: Record<number, number> = {};
        for (let i = 0; i < 10; i++) f[i] = 0;
        digits.forEach(d => { f[d] = (f[d] ?? 0) + 1; });
        const digitInfo = Array.from({ length: 10 }, (_, d) => ({
            digit: d,
            count: f[d],
            percent: (f[d] / total) * 100,
        }));
        dcirclesStore.update({
            symbol,
            digits,
            freq: f,
            total,
            latestDigit: digits.at(-1) ?? null,
            digitInfo,
        });
    }, [digits, symbol]);

    const latestDigit = digits.at(-1) ?? null;
    const total = digits.length || 1;

    const freq = useMemo(() => {
        const map: Record<number, number> = {};
        for (let i = 0; i < 10; i++) map[i] = 0;
        digits.forEach(d => map[d]++);
        return map;
    }, [digits]);

    const ranked = useMemo(() =>
        Object.entries(freq)
            .map(([d, c]) => ({ digit: Number(d), count: c }))
            .sort((a, b) => b.count - a.count),
    [freq]);

    const most = ranked[0]?.digit;
    const secondMost = ranked[1]?.digit;
    const secondLeast = ranked[8]?.digit;
    const least = ranked[9]?.digit;

    const circleColor = (d: number) => {
        if (d === most) return isDark ? '#00ff66' : '#00aa44';
        if (d === secondMost) return '#3399ff';
        if (d === secondLeast) return isDark ? '#ff9900' : '#e07700';
        if (d === least) return '#ff3333';
        return isDark ? '#444' : '#aaa';
    };

    const signals = useMemo(() => analyzeSignals(freq, total), [freq, total]);

    const over = digits.filter(d => d >= 5).length;
    const under = digits.filter(d => d < 5).length;
    const overPct = ((over / total) * 100).toFixed(1);
    const underPct = ((under / total) * 100).toFixed(1);

    const recentStream = digits.slice(-30);

    // ── Theme-aware style values ──
    const bg        = isDark ? '#0f1117' : '#ffffff';
    const circleBg  = isDark ? '#12151c' : '#f5f7fa';
    const streamBg  = isDark ? '#0c0e14' : '#f0f2f5';
    const signalBg  = isDark ? '#12151e' : '#f5f7fb';
    const barWrapBg = isDark ? '#1a1d26' : '#e9ecef';
    const borderCol = isDark ? '#1e2130' : '#e0e4f0';
    const titleCol  = isDark ? '#444' : '#888';
    const ticksCol  = isDark ? '#333' : '#aaa';
    const textCol   = isDark ? '#aaa' : '#555';

    const applyLimit = (raw: string) => {
        let n = Number(raw);
        if (isNaN(n) || raw === '') n = tickLimit;
        const clamped = Math.max(100, Math.min(5000, Math.round(n)));
        setLimitInput(String(clamped));
        setIsEditingLimit(false);
        if (clamped !== tickLimit) globalTickEngine.setLimit(clamped);
    };

    return (
        <div style={{ ...S.wrap, background: bg, border: `1px solid ${borderCol}` }}>
            <div style={S.header}>
                <span style={{ ...S.title, color: titleCol }}>Live DCircles</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ ...S.ticks, color: ticksCol }}>Last</span>
                    <input
                        ref={limitInputRef}
                        type='text'
                        value={limitInput}
                        onFocus={() => setIsEditingLimit(true)}
                        onChange={e => {
                            const v = e.target.value;
                            if (v === '' || /^\d+$/.test(v)) setLimitInput(v);
                        }}
                        onKeyDown={e => {
                            if (e.key === 'Enter') {
                                applyLimit(limitInput);
                                limitInputRef.current?.blur();
                            }
                        }}
                        onBlur={() => applyLimit(limitInput)}
                        style={{
                            width: 52,
                            padding: '2px 5px',
                            borderRadius: 5,
                            border: `1px solid ${isEditingLimit ? '#00bfff' : borderCol}`,
                            background: isDark ? '#1a1d26' : '#f0f2f5',
                            color: isDark ? '#00bfff' : '#0077cc',
                            fontSize: 10,
                            fontFamily: 'monospace',
                            textAlign: 'center',
                            outline: 'none',
                        }}
                    />
                    <span style={{ ...S.ticks, color: ticksCol }}>ticks</span>
                </div>
            </div>

            {/* ── Circles grid: row 0-4, row 5-9 ── */}
            <div style={S.circlesSection}>
                {[0, 5].map(rowStart => (
                    <div key={rowStart} style={S.circleRow}>
                        {Array.from({ length: 5 }, (_, i) => rowStart + i).map(d => {
                            const pct = (freq[d] / total) * 100;
                            const isActive = d === latestDigit;
                            const col = circleColor(d);

                            return (
                                <div key={d} style={S.circleWrap}>
                                    {/* cursor arrow */}
                                    <div style={{
                                        ...S.cursor,
                                        opacity: isActive ? 1 : 0,
                                        animation: isActive ? 'dcPulse 0.8s ease-in-out infinite' : 'none',
                                    }} />

                                    <div style={{
                                        ...S.circle,
                                        borderColor: col,
                                        boxShadow: isActive
                                            ? `0 0 14px ${col}88`
                                            : pct > 12 ? `0 0 6px ${col}44` : 'none',
                                        background: isActive ? `${col}15` : circleBg,
                                    }}>
                                        <span style={{ color: col, fontSize: 15, fontWeight: 700 }}>{d}</span>
                                    </div>

                                    <span style={{ ...S.pct, color: col }}>
                                        {pct.toFixed(2)}%
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>

            {/* ── Over / Under bar ── */}
            <div style={{ ...S.barWrap, background: barWrapBg }}>
                <div style={{ ...S.barOver, width: `${overPct}%` }}>
                    <span style={S.barText}>Over {overPct}%</span>
                </div>
                <div style={{ ...S.barUnder, width: `${underPct}%` }}>
                    <span style={S.barText}>Under {underPct}%</span>
                </div>
            </div>

            {/* ── Signals ── */}
            {signals.length > 0 && (
                <div style={S.signals}>
                    {signals.map((sig, i) => {
                        const bColor = sig.type === 'HOT' ? (isDark ? '#00ff66' : '#00aa44')
                            : sig.type === 'COLD' ? '#3399ff'
                            : sig.type === 'OVER' ? (isDark ? '#00cc55' : '#009940')
                            : '#ff3333';
                        return (
                            <div key={i} style={{ ...S.signal, background: signalBg, borderLeftColor: bColor, color: textCol }}>
                                {sig.message}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* ── Tick stream ── */}
            <div style={{ ...S.stream, background: streamBg }}>
                {recentStream.length === 0 && (
                    <span style={{ color: isDark ? '#333' : '#bbb', fontSize: 11 }}>Waiting for ticks…</span>
                )}
                {recentStream.map((d, i, arr) => {
                    const isLast = i === arr.length - 1;
                    const col = circleColor(d);
                    return (
                        <span key={i} style={{
                            ...S.streamTick,
                            color: isLast ? (isDark ? '#fff' : '#1a1a2e') : col,
                            fontWeight: isLast ? 700 : 400,
                            transform: isLast ? 'scale(1.3)' : 'none',
                            display: 'inline-block',
                        }}>
                            {d}
                        </span>
                    );
                })}
            </div>

            <style>{`
                @keyframes dcPulse {
                    0%, 100% { transform: translateX(-50%) translateY(0); opacity: 1; }
                    50% { transform: translateX(-50%) translateY(4px); opacity: 0.5; }
                }
            `}</style>
        </div>
    );
};

export default LiveDCirclesPanel;

const S: Record<string, React.CSSProperties> = {
    wrap: {
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        height: '100%',
        boxSizing: 'border-box',
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    title: {
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 1.5,
        fontFamily: 'monospace',
    },
    ticks: {
        fontSize: 10,
        fontFamily: 'monospace',
    },
    circlesSection: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
    },
    circleRow: {
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 6,
    },
    circleWrap: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        position: 'relative',
        paddingTop: 16,
    },
    cursor: {
        position: 'absolute',
        top: 2,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 0,
        height: 0,
        borderLeft: '7px solid transparent',
        borderRight: '7px solid transparent',
        borderTop: '10px solid #e62121',
        filter: 'drop-shadow(0 0 4px #e62121)',
        transition: 'opacity 0.1s',
    },
    circle: {
        width: 46,
        height: 46,
        borderRadius: '50%',
        border: '2px solid',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.15s ease',
    },
    pct: {
        fontSize: 10,
        fontFamily: 'monospace',
        fontWeight: 600,
    },
    barWrap: {
        display: 'flex',
        height: 20,
        borderRadius: 10,
        overflow: 'hidden',
    },
    barOver: {
        background: 'linear-gradient(90deg, #00cc55, #009944)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 40,
        transition: 'width 0.4s ease',
    },
    barUnder: {
        background: 'linear-gradient(90deg, #cc2222, #991111)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 40,
        transition: 'width 0.4s ease',
        flex: 1,
    },
    barText: {
        fontSize: 10,
        color: '#fff',
        fontFamily: 'monospace',
        whiteSpace: 'nowrap',
        padding: '0 6px',
    },
    signals: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
    },
    signal: {
        borderLeft: '3px solid',
        borderRadius: 4,
        padding: '5px 10px',
        fontSize: 11,
        fontFamily: 'monospace',
    },
    stream: {
        display: 'flex',
        gap: 5,
        flexWrap: 'wrap',
        borderRadius: 6,
        padding: '7px 10px',
        minHeight: 32,
        alignItems: 'center',
    },
    streamTick: {
        fontSize: 12,
        fontFamily: 'monospace',
        transition: 'all 0.1s',
    },
};
