import React, { useEffect, useState, useMemo } from 'react';
import { globalTickEngine } from '../../bot/globalTickEngine';
import { SYMBOLS } from '../d-circles/symbols';

const DeepTrader = () => {
    const [allDigits, setAllDigits] = useState<Record<string, number[]>>(
        () => globalTickEngine.getAllDigits()
    );
    const [symbol, setSymbol] = useState(
        () => localStorage.getItem('dc_symbol') || 'R_75'
    );
    const [tickWindow, setTickWindow] = useState(500);

    useEffect(() => {
        const unsub = globalTickEngine.subscribe((sym, digits) => {
            setAllDigits(prev => ({ ...prev, [sym]: digits }));
        });
        return unsub;
    }, []);

    const analysis = useMemo(() => {
        const raw = allDigits[symbol] || [];
        const digits = raw.slice(-tickWindow);
        const total = digits.length || 1;

        const freq: Record<number, number> = {};
        for (let i = 0; i < 10; i++) freq[i] = 0;
        digits.forEach(d => freq[d]++);

        const ranked = Object.entries(freq)
            .map(([d, c]) => ({ digit: Number(d), count: c, pct: (c / total) * 100 }))
            .sort((a, b) => b.count - a.count);

        const hot = ranked[0];
        const cold = ranked[ranked.length - 1];

        const over = digits.filter(d => d >= 5).length;
        const under = digits.length - over;
        const overPct = (over / total) * 100;
        const underPct = (under / total) * 100;
        const even = digits.filter(d => d % 2 === 0).length;
        const odd = digits.length - even;
        const evenPct = (even / total) * 100;
        const oddPct = (odd / total) * 100;
        const last = digits[digits.length - 1];

        const streaks: string[] = [];
        if (digits.length >= 3) {
            let sameCount = 1;
            for (let i = digits.length - 1; i > 0; i--) {
                if (digits[i] === digits[i - 1]) sameCount++;
                else break;
            }
            if (sameCount >= 3) streaks.push(`${sameCount}× consecutive ${digits[digits.length - 1]}`);

            let eoCount = 1;
            const lastIsEven = digits[digits.length - 1] % 2 === 0;
            for (let i = digits.length - 1; i > 0; i--) {
                if ((digits[i] % 2 === 0) === (digits[i - 1] % 2 === 0)) eoCount++;
                else break;
            }
            if (eoCount >= 5) streaks.push(`${eoCount}× ${lastIsEven ? 'EVEN' : 'ODD'} run`);

            let ouCount = 1;
            const lastIsOver = digits[digits.length - 1] >= 5;
            for (let i = digits.length - 1; i > 0; i--) {
                if ((digits[i] >= 5) === (digits[i - 1] >= 5)) ouCount++;
                else break;
            }
            if (ouCount >= 5) streaks.push(`${ouCount}× ${lastIsOver ? 'OVER' : 'UNDER'} run`);
        }

        const signals: { label: string; confidence: number; type: string }[] = [];
        if (hot && hot.pct > 13) {
            signals.push({
                label: `MATCH ${hot.digit}`,
                confidence: Math.min(((hot.pct - 10) / 8) * 100, 100),
                type: 'match',
            });
        }
        if (cold && cold.pct < 7) {
            signals.push({
                label: `DIFFER ${cold.digit}`,
                confidence: Math.min(((10 - cold.pct) / 8) * 100, 100),
                type: 'differ',
            });
        }
        if (overPct > 54) signals.push({ label: 'RISE / OVER', confidence: (overPct - 50) * 5, type: 'over' });
        else if (underPct > 54) signals.push({ label: 'FALL / UNDER', confidence: (underPct - 50) * 5, type: 'under' });
        if (evenPct > 54) signals.push({ label: 'EVEN', confidence: (evenPct - 50) * 5, type: 'even' });
        else if (oddPct > 54) signals.push({ label: 'ODD', confidence: (oddPct - 50) * 5, type: 'odd' });

        return { digits, total, freq, ranked, hot, cold, overPct, underPct, evenPct, oddPct, last, streaks, signals };
    }, [allDigits, symbol, tickWindow]);

    const marketScan = useMemo(() => {
        return SYMBOLS.filter((s, i, a) => a.findIndex(x => x.value === s.value) === i).slice(0, 12).map(s => {
            const d = allDigits[s.value] || [];
            const recent = d.slice(-200);
            const total = recent.length || 1;
            const freq: Record<number, number> = {};
            for (let i = 0; i < 10; i++) freq[i] = 0;
            recent.forEach(x => freq[x]++);
            const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
            const over = recent.filter(x => x >= 5).length;
            return {
                symbol: s.value,
                label: s.label
                    .replace(' Index', '')
                    .replace('Volatility ', 'V')
                    .replace(' (1s)', '(1s)')
                    .replace('Jump ', 'J')
                    .replace('Step ', 'Step')
                    .replace('Bear Market', 'Bear')
                    .replace('Bull Market', 'Bull'),
                hot: Number(sorted[0]?.[0] ?? 0),
                hotPct: ((sorted[0]?.[1] ?? 0) / total) * 100,
                cold: Number(sorted[sorted.length - 1]?.[0] ?? 0),
                overPct: (over / total) * 100,
                ticks: recent.length,
            };
        });
    }, [allDigits]);

    const getDigitColor = (digit: number) => {
        const rank = analysis.ranked.findIndex(r => r.digit === digit);
        if (rank === 0) return '#00ff88';
        if (rank === 1) return '#33ccff';
        if (rank === 8) return '#ff9900';
        if (rank === 9) return '#ff3355';
        return '#555';
    };

    const signalColor = (type: string) => ({
        match: '#00ff88', differ: '#ff3355', over: '#00cc55',
        under: '#ff4444', even: '#3399ff', odd: '#ff9900',
    }[type] || '#aaa');

    const Card = ({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color: string }) => (
        <div style={{
            background: '#0e111a',
            border: `1px solid ${color}22`,
            borderRadius: 8,
            padding: '10px 8px',
            textAlign: 'center',
        }}>
            <div style={{ fontSize: 9, color: '#444', textTransform: 'uppercase', letterSpacing: 1.2 }}>{label}</div>
            <div style={{ fontSize: 22, color, fontWeight: 800, lineHeight: 1.3 }}>{value}</div>
            {sub && <div style={{ fontSize: 9, color: color + '99' }}>{sub}</div>}
        </div>
    );

    return (
        <div style={{
            background: '#070a10',
            color: '#e0e0e0',
            minHeight: '100%',
            padding: '12px 14px 24px',
            fontFamily: "'Roboto Mono', 'Courier New', monospace",
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            boxSizing: 'border-box',
        }}>
            {/* HEADER */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div>
                    <div style={{ fontSize: 13, color: '#00ff88', letterSpacing: 2, textTransform: 'uppercase', fontWeight: 800 }}>
                        ◉ Deep Trader Analysis
                    </div>
                    <div style={{ fontSize: 10, color: '#333', marginTop: 2 }}>
                        {analysis.total} ticks · live feed
                    </div>
                </div>
                <select
                    value={symbol}
                    onChange={e => { setSymbol(e.target.value); localStorage.setItem('dc_symbol', e.target.value); }}
                    style={{
                        background: '#0e111a', color: '#00ff88', border: '1px solid #1a2a1a',
                        borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer', outline: 'none',
                    }}
                >
                    {SYMBOLS.filter((s, i, a) => a.findIndex(x => x.value === s.value) === i).map(s => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                </select>
            </div>

            {/* STAT CARDS */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <Card label="Analyzed" value={analysis.total} color="#3399ff" />
                <Card label="Hot Digit" value={analysis.hot?.digit ?? '-'} sub={`${analysis.hot?.pct.toFixed(1)}%`} color="#00ff88" />
                <Card label="Cold Digit" value={analysis.cold?.digit ?? '-'} sub={`${analysis.cold?.pct.toFixed(1)}%`} color="#ff3355" />
            </div>

            {/* DIGIT FREQUENCY BAR CHART */}
            <div style={{ background: '#0e111a', border: '1px solid #161a28', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 9, color: '#444', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 8 }}>
                    Digit Frequency
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 4 }}>
                    {Array.from({ length: 10 }, (_, d) => {
                        const pct = (analysis.freq[d] / analysis.total) * 100;
                        const col = getDigitColor(d);
                        const isActive = d === analysis.last;
                        const barH = Math.max(Math.min(pct * 4.5, 100), 3);
                        return (
                            <div key={d} style={{ textAlign: 'center' }}>
                                <div style={{
                                    height: 48, background: '#12151e', borderRadius: 4, position: 'relative',
                                    overflow: 'hidden', border: isActive ? `1px solid ${col}` : '1px solid #1a1d28',
                                    boxShadow: isActive ? `0 0 8px ${col}44` : 'none',
                                    transition: 'box-shadow 0.2s',
                                }}>
                                    <div style={{
                                        position: 'absolute', bottom: 0, width: '100%', height: `${barH}%`,
                                        background: col + '33', borderTop: `2px solid ${col}`,
                                        transition: 'height 0.3s ease',
                                    }} />
                                    {isActive && (
                                        <div style={{
                                            position: 'absolute', top: 2, left: '50%', transform: 'translateX(-50%)',
                                            width: 0, height: 0,
                                            borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                                            borderTop: `7px solid ${col}`,
                                        }} />
                                    )}
                                    <div style={{ position: 'relative', zIndex: 1, color: col, fontWeight: 800, fontSize: 13, paddingTop: 14 }}>{d}</div>
                                </div>
                                <div style={{ fontSize: 8, color: col + 'cc', marginTop: 3, letterSpacing: -0.3 }}>{pct.toFixed(1)}%</div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* OVER/UNDER + EVEN/ODD */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ background: '#0e111a', border: '1px solid #161a28', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 9, color: '#444', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Over / Under</div>
                    <div style={{ height: 6, borderRadius: 3, overflow: 'hidden', display: 'flex', marginBottom: 6 }}>
                        <div style={{ width: `${analysis.overPct}%`, background: 'linear-gradient(90deg,#00cc55,#009944)', transition: 'width 0.4s' }} />
                        <div style={{ flex: 1, background: 'linear-gradient(90deg,#cc2222,#991111)' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 11, color: '#00cc55', fontWeight: 700 }}>↑ {analysis.overPct.toFixed(1)}%</span>
                        <span style={{ fontSize: 11, color: '#cc2222', fontWeight: 700 }}>↓ {analysis.underPct.toFixed(1)}%</span>
                    </div>
                </div>
                <div style={{ background: '#0e111a', border: '1px solid #161a28', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 9, color: '#444', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Even / Odd</div>
                    <div style={{ height: 6, borderRadius: 3, overflow: 'hidden', display: 'flex', marginBottom: 6 }}>
                        <div style={{ width: `${analysis.evenPct}%`, background: 'linear-gradient(90deg,#3399ff,#2277cc)', transition: 'width 0.4s' }} />
                        <div style={{ flex: 1, background: 'linear-gradient(90deg,#ff9900,#cc7700)' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 11, color: '#3399ff', fontWeight: 700 }}>E {analysis.evenPct.toFixed(1)}%</span>
                        <span style={{ fontSize: 11, color: '#ff9900', fontWeight: 700 }}>O {analysis.oddPct.toFixed(1)}%</span>
                    </div>
                </div>
            </div>

            {/* SIGNALS */}
            {analysis.signals.length > 0 && (
                <div style={{ background: '#0e111a', border: '1px solid #161a28', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 9, color: '#444', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 10 }}>
                        🎯 Active Signals
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {analysis.signals.map((sig, i) => {
                            const col = signalColor(sig.type);
                            const conf = Math.min(sig.confidence, 100);
                            return (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <div style={{ width: 3, height: 32, background: col, borderRadius: 2, flexShrink: 0 }} />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                            <span style={{ fontSize: 12, color: col, fontWeight: 700 }}>{sig.label}</span>
                                            <span style={{ fontSize: 10, color: col + 'bb' }}>{conf.toFixed(0)}%</span>
                                        </div>
                                        <div style={{ height: 4, background: '#1a1d28', borderRadius: 2, overflow: 'hidden' }}>
                                            <div style={{ height: '100%', width: `${conf}%`, background: `linear-gradient(90deg, ${col}, ${col}88)`, borderRadius: 2, transition: 'width 0.5s ease' }} />
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* PATTERNS */}
            {analysis.streaks.length > 0 && (
                <div style={{ background: '#0e1108', border: '1px solid #ff990033', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 9, color: '#ff9900', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 }}>
                        ⚡ Pattern Alert
                    </div>
                    {analysis.streaks.map((s, i) => (
                        <div key={i} style={{ fontSize: 12, color: '#ffbb44', marginBottom: 3 }}>◈ {s}</div>
                    ))}
                </div>
            )}

            {/* MARKET SCAN */}
            <div style={{ background: '#0e111a', border: '1px solid #161a28', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 9, color: '#444', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 10 }}>
                    Market Scan
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 6 }}>
                    {marketScan.map(m => (
                        <button
                            key={m.symbol}
                            onClick={() => { setSymbol(m.symbol); localStorage.setItem('dc_symbol', m.symbol); }}
                            style={{
                                background: m.symbol === symbol ? '#001810' : '#12151e',
                                border: `1px solid ${m.symbol === symbol ? '#00ff88' : '#1a2030'}`,
                                borderRadius: 6, padding: '7px 8px', cursor: 'pointer', textAlign: 'left', outline: 'none',
                                transition: 'all 0.15s',
                            }}
                        >
                            <div style={{ fontSize: 8, color: '#555', marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {m.label}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: 16, color: '#00ff88', fontWeight: 800 }}>{m.hot}</span>
                                <span style={{ fontSize: 10, color: '#ff3355' }}>{m.cold}</span>
                            </div>
                            <div style={{ fontSize: 8, color: m.overPct > 53 ? '#00cc55' : m.overPct < 47 ? '#cc2222' : '#333', marginTop: 3 }}>
                                {m.ticks > 0
                                    ? m.overPct > 53 ? '↑ OVER' : m.overPct < 47 ? '↓ UNDER' : '— EQUAL'
                                    : 'no data'}
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {/* TICK WINDOW */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, color: '#333' }}>Tick window:</span>
                {[100, 300, 500, 1000, 2000].map(w => (
                    <button
                        key={w}
                        onClick={() => setTickWindow(w)}
                        style={{
                            padding: '4px 10px', borderRadius: 4,
                            border: `1px solid ${tickWindow === w ? '#00ff88' : '#1a2030'}`,
                            background: tickWindow === w ? '#001a10' : 'transparent',
                            color: tickWindow === w ? '#00ff88' : '#444',
                            fontSize: 10, cursor: 'pointer', outline: 'none',
                            fontFamily: 'inherit',
                        }}
                    >{w}</button>
                ))}
            </div>

            {/* RECENT TICKS */}
            <div style={{ background: '#0e111a', border: '1px solid #161a28', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 9, color: '#444', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 8 }}>
                    Recent Ticks
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {analysis.digits.slice(-50).map((d, i, arr) => {
                        const isLast = i === arr.length - 1;
                        const col = getDigitColor(d);
                        return (
                            <span key={i} style={{
                                fontSize: isLast ? 15 : 12,
                                color: isLast ? '#fff' : col,
                                fontWeight: isLast ? 800 : 400,
                                transform: isLast ? 'scale(1.2)' : 'none',
                                display: 'inline-block',
                                transition: 'all 0.1s',
                                minWidth: isLast ? 16 : 10,
                                textAlign: 'center',
                            }}>{d}</span>
                        );
                    })}
                    {analysis.digits.length === 0 && (
                        <span style={{ color: '#333', fontSize: 11 }}>Waiting for ticks…</span>
                    )}
                </div>
            </div>
        </div>
    );
};

export default DeepTrader;
