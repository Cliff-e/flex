import { useEffect, useRef, useState } from 'react';
import {
    createChart,
    CandlestickSeries,
    IChartApi,
    ISeriesApi,
    CandlestickData,
    UTCTimestamp,
    CrosshairMode,
} from 'lightweight-charts';
import chart_api from '@/external/bot-skeleton/services/api/chart-api';

type TraderChartProps = {
    symbol: string;
    onSymbolChange: (symbol: string) => void;
    lastPrice: number | null;
    priceDirection: 'up' | 'down' | 'neutral';
};

const GRANULARITIES = [
    { label: '1m',  value: 60 },
    { label: '5m',  value: 300 },
    { label: '15m', value: 900 },
    { label: '1h',  value: 3600 },
    { label: '4h',  value: 14400 },
    { label: '1d',  value: 86400 },
];

const TraderChart = ({ symbol, lastPrice, priceDirection }: TraderChartProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef     = useRef<IChartApi | null>(null);
    const seriesRef    = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const liveSubRef   = useRef<{ unsubscribe: () => void } | null>(null);
    const subIdRef     = useRef<string | null>(null);

    const [granularity, setGranularity] = useState(60);
    const [retry, setRetry]             = useState(0);
    const [isLoading, setIsLoading]     = useState(true);
    const [error, setError]             = useState<string | null>(null);

    // ── Create / destroy chart instance once ───────────────────────────────
    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            layout: {
                background: { color: '#0f0f1a' },
                textColor:  '#9a9ab0',
            },
            grid: {
                vertLines: { color: '#1e1e30' },
                horzLines: { color: '#1e1e30' },
            },
            crosshair: { mode: CrosshairMode.Normal },
            rightPriceScale: { borderColor: '#2a2a3d' },
            timeScale: {
                borderColor:    '#2a2a3d',
                timeVisible:    true,
                secondsVisible: false,
            },
            width:  containerRef.current.clientWidth  || 600,
            height: containerRef.current.clientHeight || 400,
        });

        const series = chart.addSeries(CandlestickSeries, {
            upColor:       '#26c6a6',
            downColor:     '#ef5350',
            borderVisible: false,
            wickUpColor:   '#26c6a6',
            wickDownColor: '#ef5350',
        });

        chartRef.current  = chart;
        seriesRef.current = series;

        const ro = new ResizeObserver(entries => {
            const { width, height } = entries[0].contentRect;
            chart.applyOptions({ width, height });
        });
        ro.observe(containerRef.current);

        return () => {
            ro.disconnect();
            chart.remove();
            chartRef.current  = null;
            seriesRef.current = null;
        };
    }, []);

    // ── Fetch history + subscribe on symbol / granularity / retry change ───
    useEffect(() => {
        if (!seriesRef.current) return;

        setIsLoading(true);
        setError(null);

        // Clean up previous live subscription
        liveSubRef.current?.unsubscribe();
        liveSubRef.current = null;
        if (subIdRef.current && (chart_api as any).api) {
            try { (chart_api as any).api.forget(subIdRef.current).catch(() => {}); } catch { /* ignore */ }
            subIdRef.current = null;
        }

        const series = seriesRef.current;
        const candleMap = new Map<number, CandlestickData>();
        let cancelled = false;

        const safeSymbol =
            typeof symbol === 'string' && symbol.trim() && symbol !== 'undefined'
                ? symbol
                : 'R_100';

        (chart_api as any).waitReady().then(() => {
            if (cancelled) return;

            const api = (chart_api as any).api;
            if (!api) {
                setError('Chart API unavailable');
                setIsLoading(false);
                return;
            }

            api.send({
                ticks_history: safeSymbol,
                style:         'candles',
                granularity,
                count:         500,
                end:           'latest',
                subscribe:     1,
            })
            .then((history: any) => {
                if (cancelled) return;

                const subId: string | undefined = history?.subscription?.id;
                if (subId) subIdRef.current = subId;

                const rawCandles: any[] = history?.candles ?? [];
                if (rawCandles.length > 0) {
                    rawCandles
                        .map((c: any) => ({
                            time:  c.epoch as UTCTimestamp,
                            open:  parseFloat(c.open),
                            high:  parseFloat(c.high),
                            low:   parseFloat(c.low),
                            close: parseFloat(c.close),
                        }))
                        .sort((a, b) => (a.time as number) - (b.time as number))
                        .forEach(c => candleMap.set(c.time as number, c));
                    series.setData([...candleMap.values()]);
                    chartRef.current?.timeScale().fitContent();
                }

                setIsLoading(false);
                setError(null);

                // Subscribe to live ohlc updates for this subscription ID
                if (subId && api) {
                    const liveSub = api.onMessage().subscribe(({ data }: any) => {
                        if (!data || cancelled) return;
                        if (data.msg_type !== 'ohlc' || !data.ohlc) return;
                        const o = data.ohlc;
                        if (o.id !== subId) return;

                        const bar: CandlestickData = {
                            time:  parseInt(o.open_time ?? o.epoch, 10) as UTCTimestamp,
                            open:  parseFloat(o.open),
                            high:  parseFloat(o.high),
                            low:   parseFloat(o.low),
                            close: parseFloat(o.close),
                        };
                        candleMap.set(bar.time as number, bar);
                        series.update(bar);
                    });
                    liveSubRef.current = liveSub;
                }
            })
            .catch((err: any) => {
                if (cancelled) return;
                setError(err?.error?.message ?? err?.message ?? 'Failed to load chart');
                setIsLoading(false);
            });
        }).catch(() => {
            if (!cancelled) {
                setError('Connection failed');
                setIsLoading(false);
            }
        });

        return () => {
            cancelled = true;
            liveSubRef.current?.unsubscribe();
            liveSubRef.current = null;
        };
    }, [symbol, granularity, retry]);

    const priceClass = `trader-chart__price trader-chart__price--${priceDirection}`;

    return (
        <div className='trader-chart'>
            <div className='trader-chart__header'>
                <span className='trader-chart__symbol'>{symbol}</span>
                {lastPrice !== null && (
                    <span className={priceClass}>{lastPrice}</span>
                )}
                <div className='trader-chart__granularity'>
                    {GRANULARITIES.map(g => (
                        <button
                            key={g.value}
                            className={`trader-chart__gran-btn${granularity === g.value ? ' trader-chart__gran-btn--active' : ''}`}
                            onClick={() => setGranularity(g.value)}
                        >
                            {g.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className='trader-chart__body'>
                {isLoading && (
                    <div className='trader-chart__overlay'>
                        <div className='trader-chart__spinner' />
                        <span>Loading chart…</span>
                    </div>
                )}
                {!isLoading && error && (
                    <div className='trader-chart__overlay trader-chart__overlay--error'>
                        <span>⚠ {error}</span>
                        <button
                            className='trader-chart__retry-btn'
                            onClick={() => setRetry(n => n + 1)}
                        >
                            Retry
                        </button>
                    </div>
                )}
                <div ref={containerRef} className='trader-chart__canvas' />
            </div>
        </div>
    );
};

export default TraderChart;
