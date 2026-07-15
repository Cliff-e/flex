import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    TradingEngine,
    Strategy,
    EngineStatus,
    TradingConfig,
    ExitDigitEntry,
} from '../../bot/tradingEngine';
import LiveDCirclesPanel from '../../components/live-dcircles-panel/LiveDCirclesPanel';
import PerformanceDashboard from '../../components/performance-dashboard/PerformanceDashboard';
import DigitHeatmap from '../../components/digit-heatmap/DigitHeatmap';
import { AuthSessionManager } from '../../utils/AuthSessionManager';
import { useStore } from '@/hooks/useStore';
import { globalTickEngine } from '../../bot/globalTickEngine';

// ─── Constants ──────────────────────────────────────────────────────────────

const SYMBOLS = [
    { label: 'Volatility 75 Index', value: 'R_75' },
    { label: 'Volatility 100 Index', value: 'R_100' },
    { label: 'Volatility 25 Index', value: 'R_25' },
    { label: 'Volatility 50 Index', value: 'R_50' },
    { label: 'Volatility 10 Index', value: 'R_10' },
    { label: 'Volatility 75 (1s) Index', value: '1HZ75V' },
    { label: 'Volatility 100 (1s) Index', value: '1HZ100V' },
    { label: 'Volatility 25 (1s) Index', value: '1HZ25V' },
    { label: 'Volatility 50 (1s) Index', value: '1HZ50V' },
    { label: 'Volatility 10 (1s) Index', value: '1HZ10V' },
    { label: 'Volatility 30 (1s) Index', value: '1HZ30V' },
    { label: 'Volatility 90 (1s) Index', value: '1HZ90V' },
];

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const STATE_LABELS: Record<string, string> = {
    idle: '⏸ Idle',
    monitoring: '👁 Monitoring',
    executing: '⚡ Executing',
    recovery: '🔄 Recovery',
    stopped: '🛑 Stopped',
};

const STATE_COLORS: Record<string, string> = {
    idle: '#555',
    monitoring: '#00bfff',
    executing: '#ffa500',
    recovery: '#c084fc',
    stopped: '#ff4444',
};

// ─── Auth hook — canonical single source of truth ────────────────────────────
//
// RULE: AI bot MUST NOT read localStorage directly for auth.
// All auth state comes exclusively from AuthSessionManager.getCanonicalAuthState().

function useAuth() {
    const [authState, setAuthState] = useState(() => {
        const { accessToken, accountId } = AuthSessionManager.getAuthInfo();
        return { token: accessToken, loginId: accountId ?? '' };
    });

    useEffect(() => {
        const refresh = () => {
            const { accessToken, accountId } = AuthSessionManager.getAuthInfo();
            setAuthState({ token: accessToken, loginId: accountId ?? '' });
        };

        // WS authorize completed (login / logout confirmed by server)
        const unsubAuthChange = AuthSessionManager.onAuthChange(refresh);
        // Cross-tab login / logout via localStorage storage event
        window.addEventListener('storage', refresh);

        return () => {
            unsubAuthChange();
            window.removeEventListener('storage', refresh);
        };
    }, []);

    return { token: authState.token, loginId: authState.loginId };
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function getStyles(isDark: boolean): Record<string, React.CSSProperties> {
    const bg        = isDark ? '#0a0a0a' : '#f0f2f5';
    const panel     = isDark ? '#111111' : '#ffffff';
    const header    = isDark ? '#141414' : '#f1f3f5';
    const inputBg   = isDark ? '#161616' : '#f5f7fa';
    const border    = isDark ? '#1e1e1e' : '#dde1e7';
    const inputBdr  = isDark ? '#282828' : '#c8d0da';
    const textMain  = isDark ? '#e0e0e0' : '#1a1a2e';
    const textSub   = isDark ? '#888888' : '#555555';
    const textMuted = isDark ? '#555555' : '#777777';
    const textDim   = isDark ? '#444444' : '#999999';
    return {
    page: { padding: '14px', maxWidth: 1360, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12, background: bg, color: textMain, fontFamily: 'monospace', boxSizing: 'border-box' },
    splitRow: { display: 'grid', gridTemplateColumns: '600px 1fr', gap: 14, alignItems: 'start' },
    leftCol: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
    rightCol: { position: 'sticky' as const, top: 14 },
    divider: { borderTop: `1px solid ${border}` },
    authBanner: { padding: '8px 12px', borderRadius: 6, border: '1px solid', fontSize: 12 },
    statusBar: { display: 'flex', gap: 18, alignItems: 'center', padding: '9px 14px', background: panel, border: `1px solid ${border}`, borderRadius: 8, fontSize: 13, flexWrap: 'wrap' },
    form: { display: 'flex', flexDirection: 'column', gap: 12, background: panel, padding: 14, borderRadius: 10, border: `1px solid ${border}` },
    row: { display: 'flex', flexDirection: 'column', gap: 4 },
    grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
    label: { fontSize: 10, color: textMuted, textTransform: 'uppercase', letterSpacing: 1 },
    sublabel: { fontSize: 10, color: textDim },
    hint: { fontSize: 10, color: textDim, marginTop: 2 },
    strategyGroup: { display: 'flex', gap: 8 },
    stratBtn: { flex: 1, padding: '8px 0', borderRadius: 6, border: '1px solid', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 1, transition: 'all 0.15s' },
    select: { background: inputBg, color: isDark ? '#ccc' : '#333', border: `1px solid ${inputBdr}`, padding: '6px 8px', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', width: '100%' },
    input: { background: inputBg, color: isDark ? '#ccc' : '#333', border: `1px solid ${inputBdr}`, padding: '6px 8px', borderRadius: 6, fontSize: 12, width: '100%', boxSizing: 'border-box' },
    infoBox: { background: isDark ? '#0a0a0a' : '#f0f7ff', border: `1px solid ${isDark ? '#1a1a1a' : '#c0d8f0'}`, borderLeft: '3px solid #00bfff', padding: '7px 12px', fontSize: 11, color: isDark ? '#666' : '#4a6a88', borderRadius: 6, lineHeight: 1.6 },
    differSection: { display: 'flex', flexDirection: 'column', gap: 10, background: isDark ? '#0d0d1a' : '#f5f0ff', border: `1px solid ${isDark ? '#2a1a4a' : '#d0c0f0'}`, borderRadius: 8, padding: 12 },
    accordion: { display: 'flex', flexDirection: 'column', gap: 0, border: `1px solid ${isDark ? '#1e1e2e' : '#e0d8f5'}`, borderRadius: 6, overflow: 'hidden' },
    accordionBtn: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: isDark ? '#111' : '#f5f0ff', border: 'none', borderBottom: `1px solid ${isDark ? '#1e1e2e' : '#e0d8f5'}`, color: '#c084fc', padding: '8px 12px', cursor: 'pointer', fontSize: 11, fontFamily: 'monospace', fontWeight: 700, textAlign: 'left', width: '100%' },
    accordionBody: { display: 'flex', flexDirection: 'column', gap: 6, background: isDark ? '#0a0a0a' : '#f8f4ff', padding: '10px 12px' },
    seqInfo: { background: isDark ? '#0d0d1a' : '#f5f0ff', border: `1px solid ${isDark ? '#2a1a4a' : '#d0c0f0'}`, borderLeft: '3px solid #c084fc', borderRadius: 6, padding: '10px 12px', fontSize: 11, lineHeight: 1.6 },
    actions: { display: 'flex', gap: 10, alignItems: 'center' },
    actionBtn: { padding: '10px 28px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 1 },
    startBtn: { background: '#00c853', color: '#000' },
    startBtnDisabled: { background: isDark ? '#1a2a1a' : '#d8f0e0', color: isDark ? '#3a5a3a' : '#7aaa7a', cursor: 'not-allowed' },
    stopBtn: { background: '#ff1744', color: '#fff' },
    digitStripWrap: { background: panel, border: `1px solid ${border}`, borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
    digitStripLabel: { fontSize: 10, color: textDim, textTransform: 'uppercase', letterSpacing: 1 },
    digitStrip: { display: 'flex', gap: 4, flexWrap: 'wrap' },
    digitCell: { width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, fontSize: 12, fontWeight: 700, position: 'relative', cursor: 'default' },
    digitLegend: { display: 'flex', gap: 12, fontSize: 10, color: textDim },
    };
}

// ─── Sub-components ──────────────────────────────────────────────────────────

const ExitDigitStrip: React.FC<{ entries: ExitDigitEntry[]; isDark: boolean; S: Record<string, React.CSSProperties> }> = ({ entries, isDark, S }) => (
    <div style={S.digitStripWrap}>
        <span style={S.digitStripLabel}>Last 20 Exit Digits</span>
        <div style={S.digitStrip}>
            {entries.length === 0 && (
                <span style={{ color: isDark ? '#333' : '#aaa', fontSize: 11, padding: '0 4px' }}>no data yet</span>
            )}
            {entries.map((e, i) => {
                let bg = isDark ? '#1e1e1e' : '#f0f0f0';
                let color = isDark ? '#444' : '#aaa';
                let border = `1px solid ${isDark ? '#2a2a2a' : '#e0e0e0'}`;

                if (e.source === 'real') {
                    if (e.won) {
                        bg = isDark ? '#0a2e1a' : '#e8fff4'; color = isDark ? '#00ff66' : '#00aa44'; border = `1px solid ${isDark ? '#00ff66' : '#00aa44'}`;
                    } else {
                        bg = isDark ? '#2e0a0a' : '#fff0f0'; color = '#ff4444'; border = '1px solid #ff4444';
                    }
                } else {
                    bg = isDark ? '#1a1a1a' : '#f5f5f5'; color = isDark ? '#555' : '#bbb'; border = `1px solid ${isDark ? '#333' : '#e5e5e5'}`;
                }

                return (
                    <div key={i} style={{ ...S.digitCell, background: bg, color, border }} title={e.source === 'real' ? (e.won ? 'Real — Win' : 'Real — Loss') : 'Virtual'}>
                        {e.digit}
                        {e.source === 'real' && (
                            <span style={{ position: 'absolute', bottom: 1, right: 2, fontSize: 5, color: e.won ? '#00ff66' : '#ff4444' }}>
                                {e.won ? '▲' : '▼'}
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
        <div style={S.digitLegend}>
            <span><span style={{ color: '#00ff66' }}>■</span> Real Win</span>
            <span><span style={{ color: '#ff4444' }}>■</span> Real Loss</span>
            <span><span style={{ color: '#444' }}>■</span> Virtual</span>
        </div>
    </div>
);


// ─── Main component ──────────────────────────────────────────────────────────

const AiBots: React.FC = () => {
    const { token, loginId } = useAuth();

    // ── Theme (defaults to light mode) ──
    const [isDark, setIsDark] = React.useState(() => localStorage.getItem('ai_bots_theme') === 'dark');
    const toggleTheme = () => {
        const next = !isDark;
        setIsDark(next);
        localStorage.setItem('ai_bots_theme', next ? 'dark' : 'light');
    };
    const S = getStyles(isDark);

    // Config
    const [strategy, setStrategy] = useState<Strategy>('OVER_1');
    const [symbol, setSymbol] = useState('R_75');
    const [stake, setStake] = useState(1);
    const [martingaleMultiplier, setMartingaleMultiplier] = useState(1);
    const [tickHistoryLimit, setTickHistoryLimit] = useState(() => globalTickEngine.getLimit());
    const [targetProfit, setTargetProfit] = useState(10);
    const [stopLoss, setStopLoss] = useState(5);

    // Differ strategy
    const [differDigits, setDifferDigits] = useState<number[]>([0, 2, 8, 5]);
    const [differSubStrat, setDifferSubStrat] = useState<'MANUAL' | 'SEQUENCE'>('MANUAL');
    const [differOpen, setDifferOpen] = useState(true);

    // Engine state
    const engineRef = useRef<TradingEngine | null>(null);
    const defaultStatus = (): EngineStatus => ({
        state: 'idle',
        profit: 0,
        trades: 0,
        currentStake: stake,
        exitDigitLog: [],
        tradeHistory: [],
        logs: [],
    });
    const [status, setStatus] = useState<EngineStatus>(defaultStatus);
    const isRunning = status.state !== 'idle' && status.state !== 'stopped';
    const stateColor = STATE_COLORS[status.state] ?? '#555';

    // Cleanup on unmount
    useEffect(() => () => { engineRef.current?.stop(); }, []);

    // ── Shared Blockly infrastructure ─────────────────────────────────────────
    // useStore() provides access to the same MobX stores used by the Blockly
    // Bot Builder: run_panel, transactions, summary_card, journal.
    // When the AI bot starts we call run_panel.registerBotListeners() so that
    // the observer events emitted by TradingEngine (bot.contract,
    // contract.status, ui.log.success) are routed to the same stores that
    // power the Summary / Transactions / Journal run-panel tabs.
    const store = useStore();

    // ── Auth lifecycle guards ─────────────────────────────────────────────────
    // The engine is account-specific. Stop it immediately when the session is
    // invalidated (logout / token expiry) or the active account changes, so the
    // bot never executes trades against a stale or switched session.

    // Stop on logout / token loss
    useEffect(() => {
        if (!token && engineRef.current) {
            engineRef.current.stop();
            store?.run_panel?.unregisterBotListeners();
            engineRef.current = null;
        }
    }, [token, store]);

    // Stop on account switch
    const prevLoginIdRef = useRef(loginId);
    useEffect(() => {
        if (prevLoginIdRef.current && prevLoginIdRef.current !== loginId && engineRef.current) {
            engineRef.current.stop();
            store?.run_panel?.unregisterBotListeners();
            engineRef.current = null;
        }
        prevLoginIdRef.current = loginId;
    }, [loginId, store]);

    const handleStart = useCallback(async () => {
        if (isRunning || !token) return;

        const resolvedStrategy: Strategy =
            strategy === 'DIFFER' && differSubStrat === 'SEQUENCE' ? 'DIFFER_SEQUENCE' : strategy;

        const config: TradingConfig = {
            strategy: resolvedStrategy,
            symbol,
            stake,
            martingaleMultiplier,
            targetProfit,
            stopLoss,
            ...(strategy === 'DIFFER' && differSubStrat === 'MANUAL' ? { differDigits } : {}),
        };

        // Register the shared observer listeners (TransactionsStore,
        // SummaryCardStore, RunPanelStore) before starting the engine so
        // they are in place to receive the very first bot.contract event.
        // This is the same call the Blockly Bot Builder makes on Run.
        store?.run_panel?.registerBotListeners();

        const engine = new TradingEngine(config);
        engine.setStatusCallback(s => setStatus(s));
        engineRef.current = engine;
        setStatus(defaultStatus());

        try {
            await engine.start();
        } catch {
            // errors surface via logs
        }
    }, [isRunning, token, strategy, differSubStrat, differDigits, symbol, stake, martingaleMultiplier, targetProfit, stopLoss, store]);

    const handleStop = useCallback(() => {
        engineRef.current?.stop();
        // Unregister the shared bot listeners after the engine stops so
        // they do not interfere with a subsequent Blockly bot session.
        store?.run_panel?.unregisterBotListeners();
        engineRef.current = null;
    }, [store]);

    const profitColor = status.profit > 0 ? '#00ff66' : status.profit < 0 ? '#ff4444' : '#888';

    return (
        <div style={S.page} className='ai-bots-page'>

            {/* ── Theme toggle ── */}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                    onClick={toggleTheme}
                    style={{
                        background: isDark ? '#1a1a1a' : '#e8edf3',
                        border: `1px solid ${isDark ? '#333' : '#c8d0da'}`,
                        color: isDark ? '#aaa' : '#555',
                        borderRadius: 20,
                        padding: '4px 14px',
                        fontSize: 12,
                        cursor: 'pointer',
                        fontFamily: 'monospace',
                        transition: 'all 0.2s',
                    }}
                >
                    {isDark ? '☀ Light mode' : '🌙 Dark mode'}
                </button>
            </div>

            {/* ══════════════════════════════════════════
                SPLIT: left = bot controls | right = DCircles
            ══════════════════════════════════════════ */}
            <div style={S.splitRow} className='ai-bots-split'>

                {/* ── LEFT: original bot controls (unchanged) ── */}
                <div style={S.leftCol}>

                    {/* ── Auth banner ── */}
                    <div style={{ ...S.authBanner, borderColor: token ? '#00ff6633' : '#ff990033', background: token ? (isDark ? '#001a0d' : '#e8fff4') : (isDark ? '#1a0d00' : '#fff8e8') }}>
                        {token ? (
                            <span style={{ color: '#00ff66', fontSize: 12 }}>
                                ✅ Logged in{loginId ? ` — ${loginId}` : ''} — bot will use your session automatically
                            </span>
                        ) : (
                            <span style={{ color: '#ff9900', fontSize: 12 }}>
                                ⚠️ Not logged in — log in to the site and the bot will detect your session automatically
                            </span>
                        )}
                    </div>

                    {/* ── Status bar ── */}
                    <div style={{ ...S.statusBar, borderColor: stateColor }}>
                        <span style={{ color: stateColor, fontWeight: 700, minWidth: 120 }}>{STATE_LABELS[status.state] ?? status.state}</span>
                        <span style={{ color: profitColor }}>
                            P&amp;L: <strong>{status.profit >= 0 ? '+' : ''}{status.profit.toFixed(2)}</strong>
                        </span>
                        <span style={{ color: '#888' }}>
                            Trades: <strong style={{ color: '#fff' }}>{status.trades}</strong>
                        </span>
                        {isRunning && martingaleMultiplier > 1 && (
                            <span style={{ color: '#ffa500' }}>
                                Stake: <strong>${status.currentStake.toFixed(2)}</strong>
                            </span>
                        )}
                    </div>

                    {/* ── Config form ── */}
                    <div style={S.form}>

                        {/* Strategy */}
                        <div style={S.row}>
                            <label style={S.label}>Strategy</label>
                            <div style={S.strategyGroup}>
                                {(['OVER_1', 'UNDER_8', 'DIFFER'] as Strategy[]).map(s => (
                                    <button
                                        key={s}
                                        disabled={isRunning}
                                        style={{
                                            ...S.stratBtn,
                                            background: strategy === s ? '#00bfff18' : 'transparent',
                                            borderColor: strategy === s ? '#00bfff' : '#333',
                                            color: strategy === s ? '#00bfff' : '#666',
                                        }}
                                        onClick={() => setStrategy(s)}
                                    >
                                        {s === 'OVER_1' ? 'OVER 1' : s === 'UNDER_8' ? 'UNDER 8' : 'DIFFER'}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* ── DIFFER sub-strategy section ── */}
                        {strategy === 'DIFFER' && (
                            <div style={S.differSection}>
                                {/* Sub-strategy toggle */}
                                <div style={S.row}>
                                    <label style={S.label}>Differ Mode</label>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        {(['MANUAL', 'SEQUENCE'] as const).map(m => (
                                            <button
                                                key={m}
                                                disabled={isRunning}
                                                style={{
                                                    ...S.stratBtn,
                                                    background: differSubStrat === m ? '#c084fc18' : 'transparent',
                                                    borderColor: differSubStrat === m ? '#c084fc' : '#333',
                                                    color: differSubStrat === m ? '#c084fc' : '#666',
                                                    fontSize: 11,
                                                    padding: '5px 12px',
                                                }}
                                                onClick={() => setDifferSubStrat(m)}
                                            >
                                                {m === 'MANUAL' ? '🎛 Manual Differ' : '🤖 Auto Sequence'}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Manual Differ — 4 digit slots with accordion */}
                                {differSubStrat === 'MANUAL' && (
                                    <div style={S.accordion}>
                                        <button
                                            style={S.accordionBtn}
                                            onClick={() => setDifferOpen(o => !o)}
                                            disabled={isRunning}
                                        >
                                            <span>🎯 Differ Digits (4 slots)</span>
                                            <span style={{ fontSize: 10, color: '#666' }}>{differOpen ? '▲ collapse' : '▼ expand'}</span>
                                        </button>
                                        {differOpen && (
                                            <div style={S.accordionBody}>
                                                <span style={{ ...S.sublabel, marginBottom: 6 }}>
                                                    Bot fires a DIFFER trade when the current tick ends on any of these digits:
                                                </span>
                                                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                                    {[0, 1, 2, 3].map(idx => (
                                                        <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
                                                            <span style={{ ...S.sublabel, fontSize: 10 }}>Digit {idx + 1}</span>
                                                            <select
                                                                value={differDigits[idx] ?? 0}
                                                                disabled={isRunning}
                                                                onChange={e => {
                                                                    const updated = [...differDigits];
                                                                    updated[idx] = Number(e.target.value);
                                                                    setDifferDigits(updated);
                                                                }}
                                                                style={{ ...S.select, width: 56 }}
                                                            >
                                                                {DIGITS.map(d => <option key={d} value={d}>{d}</option>)}
                                                            </select>
                                                        </div>
                                                    ))}
                                                </div>
                                                <span style={{ ...S.hint, marginTop: 6 }}>
                                                    Entry triggers on: {differDigits.join(', ')}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Auto Sequence — info display */}
                                {differSubStrat === 'SEQUENCE' && (
                                    <div style={S.seqInfo}>
                                        <div style={{ color: '#c084fc', fontWeight: 700, fontSize: 12, marginBottom: 8 }}>
                                            🤖 Auto-Sequence Logic
                                        </div>
                                        <div style={{ color: '#888', fontSize: 11, lineHeight: 1.7 }}>
                                            Entry 1 — DIFFER <strong style={{ color: '#fff' }}>0</strong><br />
                                            Entry 2 — DIFFER <strong style={{ color: '#fff' }}>3</strong> (increments +1 each cycle)<br />
                                            Entry 3+ — prev × 2 + 3, last digit<br />
                                            <span style={{ color: '#c084fc' }}>Example: 0 → 3 → 9 → 1 → 5 → 3 → 9 → 1 → 5 → 3</span>
                                        </div>
                                        <div style={{ color: '#666', fontSize: 10, marginTop: 6, borderTop: '1px solid #1e1e1e', paddingTop: 6 }}>
                                            Fires 10 entries/cycle · Cycle 2: d2=4, Cycle 3: d2=5 … until TP hit
                                        </div>
                                        <div style={{ color: '#ffa500', fontSize: 10, marginTop: 4 }}>
                                            ⚡ Fixed stake per entry · Recovery always flat stake (no martingale)
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Two-column grid for config */}
                        <div style={S.grid2}>
                            <div style={S.row}>
                                <label style={S.label}>Market</label>
                                <select value={symbol} disabled={isRunning} onChange={e => setSymbol(e.target.value)} style={S.select}>
                                    {SYMBOLS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                                </select>
                            </div>

                            <div style={S.row}>
                                <label style={S.label}>Stake (USD)</label>
                                <input type='number' min='0.35' step='0.01' value={stake} disabled={isRunning}
                                    onChange={e => setStake(Number(e.target.value))} style={S.input} />
                                <span style={S.hint}>3 trades per entry</span>
                            </div>

                            <div style={S.row}>
                                <label style={S.label}>Take Profit (USD)</label>
                                <input type='number' min='0.01' step='0.01' value={targetProfit} disabled={isRunning}
                                    onChange={e => setTargetProfit(Number(e.target.value))} style={S.input} />
                            </div>

                            <div style={S.row}>
                                <label style={S.label}>Stop Loss (USD)</label>
                                <input type='number' min='0.01' step='0.01' value={stopLoss} disabled={isRunning}
                                    onChange={e => setStopLoss(Number(e.target.value))} style={S.input} />
                            </div>

                            <div style={S.row}>
                                <label style={S.label}>Martingale Multiplier</label>
                                <input type='number' min='1' max='10' step='0.1' value={martingaleMultiplier} disabled={isRunning}
                                    onChange={e => setMartingaleMultiplier(Number(e.target.value))} style={S.input} />
                                <span style={S.hint}>
                                    {martingaleMultiplier <= 1
                                        ? '1.0 = disabled (flat stake)'
                                        : `×${martingaleMultiplier} stake after each loss, reset on win`}
                                </span>
                            </div>

                            <div style={S.row}>
                                <label style={S.label}>Tick History Limit</label>
                                <select
                                    value={tickHistoryLimit}
                                    disabled={isRunning}
                                    onChange={e => {
                                        const n = Number(e.target.value);
                                        setTickHistoryLimit(n);
                                        globalTickEngine.setLimit(n);
                                    }}
                                    style={S.select}
                                >
                                    {[100, 500, 1000, 3000, 5000].map(n => (
                                        <option key={n} value={n}>{n.toLocaleString()} ticks</option>
                                    ))}
                                </select>
                                <span style={S.hint}>
                                    Shared with DCircles &amp; all analytics — affects confirmation accuracy
                                </span>
                            </div>
                        </div>

                        {/* Info box */}
                        <div style={S.infoBox}>
                            {strategy === 'OVER_1' && <>
                                <strong>OVER 1</strong> — DCircles confirms digits 0 &amp; 1 both &lt;10.5% with no hot bar.
                                Entry fires on digit <strong>5</strong> or <strong>6</strong>.
                            </>}
                            {strategy === 'UNDER_8' && <>
                                <strong>UNDER 8</strong> — DCircles confirms digits 8 &amp; 9 both &lt;10.5% with no hot bar.
                                Entry fires on digit <strong>7</strong>, <strong>4</strong>, or <strong>9</strong>.
                            </>}
                            {strategy === 'DIFFER' && differSubStrat === 'MANUAL' && <>
                                <strong>DIFFER (Manual)</strong> — Entry fires when tick digit matches any of your 4 chosen digits.
                                Barrier is the matched digit. Recovery stake is always fixed.
                            </>}
                            {strategy === 'DIFFER' && differSubStrat === 'SEQUENCE' && <>
                                <strong>DIFFER (Auto Sequence)</strong> — Bot auto-fires 10 DIFFER entries per cycle using the
                                computed sequence (0 → d2 → prev×2+3 last digit). d2 starts at 3 and increments +1 each cycle.
                                Runs until Take Profit is hit.
                            </>}
                        </div>
                    </div>

                    {/* ── Start / Stop ── */}
                    <div style={S.actions}>
                        {!isRunning ? (
                            <button
                                style={{ ...S.actionBtn, ...(token ? S.startBtn : S.startBtnDisabled) }}
                                disabled={!token}
                                onClick={handleStart}
                                title={!token ? 'Log in to the site first' : ''}
                            >
                                ▶ Start Bot
                            </button>
                        ) : (
                            <button style={{ ...S.actionBtn, ...S.stopBtn }} onClick={handleStop}>
                                ⏹ Stop Bot
                            </button>
                        )}
                    </div>

                    {/* ── Exit digit strip ── */}
                    <ExitDigitStrip entries={status.exitDigitLog} isDark={isDark} S={S} />

                </div>{/* end leftCol */}

                {/* ── RIGHT: Live DCircles panel ── */}
                <div style={S.rightCol}>
                    <LiveDCirclesPanel symbol={symbol} isDark={isDark} />
                </div>

            </div>{/* end splitRow */}

            {/* ══════════════════════════════════════════
                BELOW SPLIT: Performance + Heatmap
            ══════════════════════════════════════════ */}
            <div style={S.divider} />
            <PerformanceDashboard history={status.tradeHistory} />
            <DigitHeatmap history={status.tradeHistory} />

        </div>
    );
};

export default AiBots;
