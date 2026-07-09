import React, { useEffect, useMemo, useRef, useState } from 'react';
import './dcircles.scss';
import { SYMBOLS } from './symbols';
import { analyzeSignals } from './signalEngine';
import { dcirclesStore } from '../../bot/dcirclesStore';
import { globalTickEngine } from '../../bot/globalTickEngine';

const DCircles = () => {
    const [symbol, setSymbol] = useState(() => localStorage.getItem('dc_symbol') || 'R_75');
    const [isDark, setIsDark] = useState(() => localStorage.getItem('dc_theme') === 'dark');
    const toggleTheme = () => {
        const next = !isDark;
        setIsDark(next);
        localStorage.setItem('dc_theme', next ? 'dark' : 'light');
    };
    

    // 📱 orientation state
    const [isLandscape, setIsLandscape] = useState(
        window.innerWidth > window.innerHeight
    );
    

    // 📦 load persisted data
    const [digitsMap, setDigitsMap] = useState<Record<string, number[]>>(() => {
        const saved = localStorage.getItem('digitsMap');
        return saved ? JSON.parse(saved) : {};
    });
    const [viewLimit, setViewLimit] = useState(() => Number(localStorage.getItem('dc_viewLimit')) || 1000);

// 👇 REQUIRED for the input to work
const inputRef = useRef<HTMLInputElement | null>(null);
const [inputValue, setInputValue] = useState<string>('1000');
const [isEditing, setIsEditing] = useState(false); 


    // =========================
    // 🔥 ORIENTATION HANDLER (FIXED LOCATION)
    // =========================
    useEffect(() => {
        const handleResize = () => {
            setIsLandscape(window.innerWidth > window.innerHeight);
        };

        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
        };
    }, []);
    useEffect(() => {
    if (!isEditing) {
        setInputValue(String(viewLimit));
    }
}, [viewLimit, isEditing]);

    // =========================
    // 🔥 SAVE TO LOCALSTORAGE
    // =========================
    
    useEffect(() => {
        localStorage.setItem('digitsMap', JSON.stringify(digitsMap));
    }, [digitsMap]);

    useEffect(() => {
        localStorage.setItem('dc_symbol', symbol);
    }, [symbol]);

    useEffect(() => {
        localStorage.setItem('dc_viewLimit', String(viewLimit));
    }, [viewLimit]);

    // =========================
    // 🔥 SUBSCRIBE TO SHARED ENGINE
    // =========================
    useEffect(() => {
        setDigitsMap(globalTickEngine.getAllDigits());

        const unsub = globalTickEngine.subscribe((sym, d) => {
            setDigitsMap(prev => ({ ...prev, [sym]: d }));
        });
        return unsub;
    }, []);
    // =========================
    // PUBLISH TO DCIRCLES STORE (bot reads this for confirmation checks)
    // =========================
    useEffect(() => {
        const raw = digitsMap[symbol] || [];
        const limited = raw.length > viewLimit ? raw.slice(-viewLimit) : raw;
        const total = limited.length || 1;
        const f: Record<number, number> = {};
        for (let i = 0; i < 10; i++) f[i] = 0;
        limited.forEach(d => (f[d] = (f[d] ?? 0) + 1));
        const digitInfo = Array.from({ length: 10 }, (_, d) => ({
            digit: d,
            count: f[d],
            percent: (f[d] / total) * 100,
        }));
        dcirclesStore.update({
            symbol,
            digits: limited,
            freq: f,
            total,
            latestDigit: limited.at(-1) ?? null,
            digitInfo,
        });
    }, [digitsMap, symbol, viewLimit]);

    // =========================
    // CURRENT DATA
    // =========================
    const rawDigits = digitsMap[symbol] || [];

// 🔥 user-controlled view window
const digits =
    rawDigits.length > viewLimit
        ? rawDigits.slice(-viewLimit)
        : rawDigits;

    const latestDigit = digits.at(-1) ?? null;

    const total = digits.length || 1;

    // =========================
    // FREQUENCY
    // =========================
    const freq = useMemo(() => {
        const map: Record<number, number> = {};
        for (let i = 0; i < 10; i++) map[i] = 0;

        digits.forEach(d => map[d]++);
        return map;
    }, [digits]);

    // =========================
    // RANKING
    // =========================
    const ranked = useMemo(() => {
        return Object.entries(freq)
            .map(([digit, count]) => ({
                digit: Number(digit),
                count
            }))
            .sort((a, b) => b.count - a.count);
    }, [freq]);

    const most = ranked[0]?.digit;
    const secondMost = ranked[1]?.digit;
    const secondLeast = ranked[8]?.digit;
    const least = ranked[9]?.digit;

    const color = (d: number) => {
        if (d === most) return isDark ? '#00ff66' : '#00aa44';
        if (d === secondMost) return '#3399ff';
        if (d === secondLeast) return isDark ? '#ff9900' : '#e07700';
        if (d === least) return '#ff3333';
        return isDark ? '#555' : '#999';
    };

    // =========================
    // SIGNALS
    // =========================
    const signals = useMemo(() => {
        return analyzeSignals(freq, total);
    }, [freq, total]);

    // =========================
    // STATS
    // =========================
    const over = digits.filter(d => d >= 5).length;
    const under = digits.filter(d => d < 5).length;

    const overPct = ((over / total) * 100).toFixed(1);
    const underPct = ((under / total) * 100).toFixed(1);

    const evenCount = digits.filter(d => d % 2 === 0).length;
    const oddCount = digits.filter(d => d % 2 !== 0).length;

    const evenPct = ((evenCount / total) * 100).toFixed(1);
    const oddPct = ((oddCount / total) * 100).toFixed(1);

    return (
        <div className={`dcircles-container ${isLandscape ? 'landscape' : 'portrait'} ${isDark ? 'theme-dark' : 'theme-light'}`}>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <h3 style={{ margin: 0 }}>DCircles (Live Multi-Market)</h3>
                <button
                    onClick={toggleTheme}
                    className='dc-theme-toggle'
                >
                    {isDark ? '☀ Light' : '🌙 Dark'}
                </button>
            </div>

            {/* SYMBOL SELECTOR */}
            <select
                className="symbol-select"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
            >
                {SYMBOLS.map(s => (
                    <option key={s.value} value={s.value}>
                        {s.label}
                    </option>
                ))}
            </select>

            {/* CIRCLES */}
           {/* 🔵 CIRCLES */}
<div className="circles-grid">

    {/* TOP ROW: 0 - 4 */}
    <div className="circle-row">
        {Object.keys(freq).map(d => {
            const digit = Number(d);
            if (digit > 4) return null;

            const percent = (freq[digit] / total) * 100;
            const isActive = digit === latestDigit;

            return (
                <div key={digit} className="circle-wrapper">
                    <div
                        className={`circle ${isActive ? 'active' : ''}`}
                        style={{
                            borderColor: color(digit),
                            boxShadow: 'none'
                        }}
                    >
                        <span>{digit}</span>
                    </div>

                    {/* ✅ 2 DECIMALS */}
                    <small>{percent.toFixed(2)}%</small>
                </div>
            );
        })}
    </div>

    {/* BOTTOM ROW: 5 - 9 */}
    <div className="circle-row">
        {Object.keys(freq).map(d => {
            const digit = Number(d);
            if (digit < 5) return null;

            const percent = (freq[digit] / total) * 100;
            const isActive = digit === latestDigit;

            return (
                <div key={digit} className="circle-wrapper">
                    <div
                        className={`circle ${isActive ? 'active' : ''}`}
                        style={{
                            borderColor: color(digit),
                            boxShadow:
                                percent > 12
                                    ? `0 0 10px ${color(digit)}`
                                    : 'none'
                        }}
                    >
                        <span>{digit}</span>
                    </div>

                    {/* ✅ 2 DECIMALS */}
                    <small>{percent.toFixed(2)}%</small>
                </div>
            );
        })}
    </div>

</div> 
                {/*symbol selector */}

<div className="tick-control">
    <label>Ticks window: {viewLimit}</label>
   
<input
    ref={inputRef}
    type="text"
    value={inputValue}

    onFocus={() => setIsEditing(true)}

    onChange={(e) => {
        const val = e.target.value;

        // ✅ allow full delete
        if (val === '') {
            setInputValue('');
            return;
        }

        // ✅ allow only digits
        if (!/^\d+$/.test(val)) return;

        setInputValue(val);

        // 🔥 LIVE UPDATE (percentages update instantly)
        let num = Number(val);

        if (num < 50) num = 50;
        if (num > 3000) num = 3000;

        setViewLimit(num);
    }}

    onKeyDown={(e) => {
        if (e.key === 'Enter') {
            let val = Number(inputValue);

            if (isNaN(val)) val = 1000;
            if (val < 50) val = 50;
            if (val > 3000) val = 3000;

            setViewLimit(val);
            setInputValue(String(val));
            setIsEditing(false);

            // 🔥 FORCE blur AFTER render (fix blinking)
            setTimeout(() => {
                inputRef.current?.blur();
            }, 0);
        }
    }}

    onBlur={() => {
        let val = Number(inputValue);

        if (isNaN(val)) val = 1000;
        if (val < 50) val = 50;
        if (val > 3000) val = 3000;

        setViewLimit(val);
        setInputValue(String(val));
        setIsEditing(false);
    }}

    placeholder="Enter ticks (50–3000)"

    style={{
        width: '150px',
        padding: '10px 14px',
        fontSize: '16px',
        borderRadius: '12px',
        border: isEditing ? '2px solid orange' : `2px solid ${isDark ? '#555' : '#ccc'}`,
        background: isDark ? '#1a1a1a' : '#f5f7fa',
        color: isDark ? 'orange' : '#cc7700',
        textAlign: 'center',
        outline: 'none',
    }}
/>

</div>

            {/* EVEN / ODD */}
            <div className="even-odd">
                <div className="even" style={{ width: `${evenPct}%` }}>
                    Even {evenPct}%
                </div>
                <div className="odd" style={{ width: `${oddPct}%` }}>
                    Odd {oddPct}%
                </div>
            </div>

            {/* OVER / UNDER */}
            <div className="bar">
                <div className="over" style={{ width: `${overPct}%` }}>
                    Over {overPct}%
                </div>
                <div className="under" style={{ width: `${underPct}%` }}>
                    Under {underPct}%
                </div>
            </div>

            {/* SIGNALS */}
            <div className="signals">
                {signals.length === 0 && <p>No strong signal</p>}
                {signals.map((s, i) => (
                    <div key={i} className={`signal ${s.type?.toLowerCase()}`}>
                        {s.message}
                    </div>
                ))}
            </div>

            {/* STREAM */}
            <div className="stream">
                {digits.slice(-60).map((d, i, arr) => (
                    <span
                        key={i}
                        className={`tick ${i === arr.length - 1 ? 'active' : ''}`}
                    >
                        {d}
                    </span>
                ))}
            </div>

            {/* EVEN / ODD TICKER */}
            <div className="ticker-container">
                <div className="ticker-track">
                   {digits.slice(-20).map((d, i, arr) => {
    const isEven = d % 2 === 0;
    const isLatest = i === arr.length - 1;

                       return (
    <div
        key={i}
        className={`tick-box ${isEven ? 'even' : 'odd'} ${isLatest ? 'latest' : ''}`}
    >
        {isEven ? 'E' : 'O'}
    </div>
);
                    })}
                </div>

                
            </div>

        </div>
    );
};

export default DCircles;