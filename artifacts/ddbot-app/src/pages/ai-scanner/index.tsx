import React, { useState, useEffect, useRef } from 'react';
import { useMultiTicks } from '../../hooks/useMultiTicks';
import { scanMarkets } from '../../scanner/core/scanMarkets';
import { shouldTrade } from '../../scanner/core/decisionEngine';
import { runStrategy } from '../../scanner/strategies';
import { BotEngine } from '../../bot/engine';
import { RuntimeLogger } from '../../runtime/RuntimeLogger';

import './ai-scanner.scss';

const SCANNER_RUNTIME_ID = 'ai-scanner';

type Strategy =
    | 'over1'
    | 'over2'
    | 'over3'
    | 'evenodd'
    | 'differ';

const symbols = [
    'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
    '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',
    'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
];


const AIScanner: React.FC = () => {

    const [strategy, setStrategy] = useState<Strategy>('over1');
    const [ticks, setTicks] = useState(100);

    const [bestMarket, setBestMarket] = useState<{
        symbol: string;
        probability: number;
        result?: any;
    } | null>(null);

    const [autoRunning, setAutoRunning] = useState(false);
    const [scanSpeed, setScanSpeed] = useState(1000);
    const [minWinRate, setMinWinRate] = useState(80);

    const [autoStatus, setAutoStatus] = useState<'idle' | 'scanning' | 'trading'>('idle');
    const [autoBest, setAutoBest] = useState<{ symbol: string; probability: number } | null>(null);

    // ✅ FIX: actual hook call
    const tickMap = useMultiTicks(symbols);

    // ✅ FIX: stable reference (prevents re-render storms)
    const tickMapRef = useRef(tickMap);
    useEffect(() => {
        tickMapRef.current = tickMap;
    }, [tickMap]);

    // ✅ FIX: no state race
    const isTradingRef = useRef(false);

    // =========================
    // 🔥 AUTO SCANNER ENGINE
    // =========================
    useEffect(() => {
        if (!autoRunning) {
            setAutoStatus('idle');
            RuntimeLogger.stop(SCANNER_RUNTIME_ID);
            return;
        }

        setAutoStatus('scanning');
        RuntimeLogger.start(SCANNER_RUNTIME_ID, {
            name: 'AI Scanner (Auto)',
            strategy,
            market: '--',
        });
        RuntimeLogger.log('INFO', 'Auto scanner started', SCANNER_RUNTIME_ID);

        const interval = setInterval(() => {
            const best = scanMarkets(
                symbols,
                tickMapRef.current,
                ticks,
                strategy,
                runStrategy
            );

            if (!best) return;

            setAutoBest(best);
            setBestMarket(best);

            if (shouldTrade(best.probability, minWinRate) && !isTradingRef.current) {
                isTradingRef.current = true;
                setAutoStatus('trading');

                RuntimeLogger.log(
                    'SUCCESS',
                    `Trade triggered on ${best.symbol} (probability ${best.probability}%)`,
                    SCANNER_RUNTIME_ID
                );
                RuntimeLogger.updateSignal(SCANNER_RUNTIME_ID, `${best.symbol} @ ${best.probability}%`);
                RuntimeLogger.setMarket(SCANNER_RUNTIME_ID, best.symbol);

                setTimeout(() => {
                    isTradingRef.current = false;
                    setAutoStatus('scanning');
                }, 2000);
            }
        }, scanSpeed);

        return () => clearInterval(interval);
    }, [autoRunning, strategy, ticks, minWinRate, scanSpeed]);

    // =========================
    // 🔍 MANUAL SCAN
    // =========================
    const handleScan = () => {
        const best = scanMarkets(
            symbols,
            tickMapRef.current,
            ticks,
            strategy,
            runStrategy
        );
        if (best) setBestMarket(best);
    };

    // =========================
    // 🎯 HELPERS
    // =========================
    const getMarketTag = (symbol: string) => {
        if (symbol.includes('1HZ')) return '⚡';
        if (symbol.includes('JD')) return '💥';
        return '📊';
    };

    const contract = bestMarket?.result?.contract ?? '--';
    const barrier = bestMarket?.result?.barrier ?? '--';

    // =========================
    // 🎨 UI
    // =========================
 const [stake, setStake] = useState(1);
const [martingale, setMartingale] = useState(2);
const [stopLoss] = useState(10);
const [targetWins, setTargetWins] = useState<number | undefined>();
const [targetProfit, setTargetProfit] = useState<number | undefined>();

    return (
        <div className="ai-scanner">

            <h3>Select Strategy</h3>

            <div className="strategy-row">
                {(['over1','over2','over3','evenodd','differ'] as Strategy[]).map(s => (
                    <button
                        key={s}
                        onClick={() => setStrategy(s)}
                        className={strategy === s ? 'active' : ''}
                    >
                        {s}
                    </button>
                ))}
            </div>

            <div className="ticks-row">
                <label>Last ticks:</label>
                <input
                    type="number"
                    value={ticks}
                    onChange={e => setTicks(Number(e.target.value))}
                />
            </div>

            <button className="scan-btn" onClick={handleScan}>
                Scan Markets
            </button>

            {/* ================= RESULT ================= */}
            {bestMarket && (
                <div className="results-wrapper">

                    <div className="result-card">
                        <h4>Best Market</h4>
                        <p>
                            <strong>{bestMarket.symbol}</strong> {getMarketTag(bestMarket.symbol)}
                        </p>
                        <p>Strategy: {strategy}</p>
                        <p className="prob">{bestMarket.probability}%</p>
                    </div>

                    {/* BOT PANEL */}
                    <div className="bot-panel">
                        <h4>Bot Config</h4>

                        <div className="form-grid">
                           <input
    type="number"
    value={stake}
    onChange={(e) => setStake(Number(e.target.value))}
    placeholder="Stake"
/>
                            
                            <input
    type="number"
    value={martingale}
    onChange={(e) => setMartingale(Number(e.target.value))}
    placeholder="Martingale"
/>
                            <input
    type="number"
    value={targetProfit}
    onChange={(e) => setTargetProfit(Number(e.target.value))}
    placeholder="Target Profit"
/>
                            <input
    type="number"
    value={targetWins}
    onChange={(e) => setTargetWins(Number(e.target.value))}
    placeholder="Wins Target"
/>
                        </div>

                        <button
    className="run-btn"
    onClick={() => {
        if (!bestMarket) return;

        const bot = new BotEngine({
            stake,
            martingale,
            stopLoss,
            targetWins,
            targetProfit
        });

        bot.start({
            symbol: bestMarket.symbol,
            contract: bestMarket.result.contract,
            barrier: bestMarket.result.barrier,
            probability: bestMarket.probability
        }, () => tickMap[bestMarket.symbol] || []);
    }}
>
    Run Bot
</button>
                    </div>

                    {/* AUTO SCANNER */}
                    <div className="auto-scanner">
                        <h4>Auto Scanner</h4>

                        <div className="form-grid">
                            <input
                                type="number"
                                value={minWinRate}
                                onChange={e => setMinWinRate(Number(e.target.value))}
                                placeholder="Min Win %"
                            />

                            <input
                                type="number"
                                value={scanSpeed}
                                onChange={e => setScanSpeed(Number(e.target.value))}
                                placeholder="Scan Speed ms"
                            />
                        </div>

                        <div className="auto-buttons">
                            <button onClick={() => setAutoRunning(true)}>START</button>
                            <button onClick={() => setAutoRunning(false)}>STOP</button>
                        </div>

                        <div className="auto-status">
                            <p>Status: <span className={autoStatus}>{autoStatus}</span></p>
                            <p>Best: {autoBest?.symbol || '--'}</p>
                            <p>Contract: {contract}</p>
                            <p>Barrier: {barrier}</p>
                            <p>Prob: {autoBest?.probability ?? '--'}%</p>
                        </div>
                    </div>

                </div>
            )}
        </div>
    );
};

export default AIScanner;