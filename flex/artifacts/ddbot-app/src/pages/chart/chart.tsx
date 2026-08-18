/**
 * Chart — renders SmartChart using the Chart Data Layer.
 *
 * Architecture (enforced):
 *  • SmartChart is a PURE PUBLIC RENDERING SYSTEM — no auth, no token, no loginid.
 *  • All data comes from ChartDataLayer (preview → live via PublicMarketSocket).
 *  • DCircles lives in its own DOM layer OUTSIDE SmartChart so it never triggers
 *    a chart re-render and remains visually stable under all tick updates.
 *  • requestAPI non-mock traffic uses PublicMarketSocket (public WS, no auth).
 *
 * DOM structure:
 *   <div.chart-outer>
 *     <div.dashboard__chart-wrapper>   ← SmartChart only
 *       <SmartChart />
 *     </div>
 *     <div.dcircles-layer>             ← fully independent
 *       <DCirclesPanel />
 *     </div>
 *   </div>
 */
import React, { useEffect, useRef, useCallback, useMemo, useState, memo } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { ChartDataLayer } from '@/utils/ChartDataLayer';
import { PublicMarketSocket } from '@/utils/PublicMarketSocket';
import { TicksStreamRequest } from '@deriv/api-types';
import { ChartTitle, SmartChart } from '@deriv/deriv-charts';
import { useDevice } from '@deriv-com/ui';
import ToolbarWidgets from './toolbar-widgets';
import DigitCircles from '../d-circles/DigitCircles';
import FloatingDCirclesWidget from './FloatingDCirclesWidget';
import ChartConnectionBadge from '@/components/chart-connection-badge/ChartConnectionBadge';
import { globalTickEngine } from '../../bot/globalTickEngine';
import '@deriv/deriv-charts/dist/smartcharts.css';

// ── Mock helpers ─────────────────────────────────────────────────────────────

const sym = (
    symbol: string, display_name: string,
    market: string, market_display_name: string,
    submarket: string, submarket_display_name: string,
    pip: string, quote_decimal_places: number
) => ({
    symbol, display_name, market, market_display_name,
    submarket, submarket_display_name, pip, quote_decimal_places,
    is_trading_suspended: 0, exchange_is_open: 1,
    // SmartChart uses symbol_type for internal categorisation; match the real API values
    symbol_type: market === 'synthetic_index' ? 'synthetic_index'
               : market === 'forex'           ? 'forex'
               : market === 'cryptocurrency'  ? 'cryptocurrency'
               : 'stockindex',
    intraday_interval_minutes: 1,
    spot: 100.00, spot_time: Math.floor(Date.now() / 1000), spot_age: 1, shortcode: symbol,
});

const ttSym = (symbol: string, name: string, days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']) => ({
    symbol, name,
    times: { open: ['00:00:00'], close: ['23:59:59'], settlement: '' },
    trading_days: days, events: [],
});

const WEEKDAYS = ['Mon','Tue','Wed','Thu','Fri'];

// ── PURE MOCKS — always returned instantly, never routed to WS ───────────────
// SmartChart stalls on these; we stub them so it never waits.
const UNSUPPORTED_MOCKS: Record<string, unknown> = {
    website_status: {
        website_status: {
            site_status: 'up', currencies_config: {},
            clients_country: 'ZA', supported_languages: ['EN'],
        },
    },
    landing_company_details: { landing_company_details: { id: 'svg' } },
    contracts_for: {
        contracts_for: {
            available: [{ delay_amount: 0, contract_type: 'CALL', barriers: 0 }],
            close: null, feed_license: 'realtime', hit_count: 1, open: null, spot: null,
        },
    },
    active_symbols: {
        active_symbols: [
            sym('R_10',   'Volatility 10 Index',        'synthetic_index','Derived','random_index',   'Continuous Indices',   '0.001',   3),
            sym('R_25',   'Volatility 25 Index',        'synthetic_index','Derived','random_index',   'Continuous Indices',   '0.001',   3),
            sym('R_50',   'Volatility 50 Index',        'synthetic_index','Derived','random_index',   'Continuous Indices',   '0.0001',  4),
            sym('R_75',   'Volatility 75 Index',        'synthetic_index','Derived','random_index',   'Continuous Indices',   '0.0001',  4),
            sym('R_100',  'Volatility 100 Index',       'synthetic_index','Derived','random_index',   'Continuous Indices',   '0.01',    2),
            sym('stpRNG', 'Step Index',                 'synthetic_index','Derived','random_index',   'Continuous Indices',   '0.1',     2),
            // 1-second indices supported by the new API (1HZ15V, 1HZ30V, 1HZ90V removed —
            // the new trading API does not include them in active_symbols and returns
            // InvalidSymbol for any tick subscription attempt on these three symbols)
            sym('1HZ10V', 'Volatility 10 (1s) Index',   'synthetic_index','Derived','random_index_s1','1 Second Indices',    '0.0001',  4),
            sym('1HZ25V', 'Volatility 25 (1s) Index',   'synthetic_index','Derived','random_index_s1','1 Second Indices',    '0.0001',  4),
            sym('1HZ50V', 'Volatility 50 (1s) Index',   'synthetic_index','Derived','random_index_s1','1 Second Indices',    '0.00001', 5),
            sym('1HZ75V', 'Volatility 75 (1s) Index',   'synthetic_index','Derived','random_index_s1','1 Second Indices',    '0.00001', 5),
            sym('1HZ100V','Volatility 100 (1s) Index',  'synthetic_index','Derived','random_index_s1','1 Second Indices',    '0.001',   3),
            sym('BOOM300N', 'Boom 300 Index',            'synthetic_index','Derived','random_daily',  'Daily Reset Indices',  '0.0001',  4),
            sym('BOOM500',  'Boom 500 Index',            'synthetic_index','Derived','random_daily',  'Daily Reset Indices',  '0.0001',  4),
            sym('BOOM1000', 'Boom 1000 Index',           'synthetic_index','Derived','random_daily',  'Daily Reset Indices',  '0.0001',  4),
            sym('CRASH300N','Crash 300 Index',           'synthetic_index','Derived','random_daily',  'Daily Reset Indices',  '0.0001',  4),
            sym('CRASH500', 'Crash 500 Index',           'synthetic_index','Derived','random_daily',  'Daily Reset Indices',  '0.0001',  4),
            sym('CRASH1000','Crash 1000 Index',          'synthetic_index','Derived','random_daily',  'Daily Reset Indices',  '0.0001',  4),
            sym('JD10',  'Jump 10 Index',  'synthetic_index','Derived','jump_index','Jump Indices','0.01',2),
            sym('JD25',  'Jump 25 Index',  'synthetic_index','Derived','jump_index','Jump Indices','0.01',2),
            sym('JD50',  'Jump 50 Index',  'synthetic_index','Derived','jump_index','Jump Indices','0.01',2),
            sym('JD75',  'Jump 75 Index',  'synthetic_index','Derived','jump_index','Jump Indices','0.01',2),
            sym('JD100', 'Jump 100 Index', 'synthetic_index','Derived','jump_index','Jump Indices','0.01',2),
            sym('JD150', 'Jump 150 Index', 'synthetic_index','Derived','jump_index','Jump Indices','0.01',2),
            sym('JD200', 'Jump 200 Index', 'synthetic_index','Derived','jump_index','Jump Indices','0.01',2),
            sym('RNGBEAR200','Range Break 200 Index',      'synthetic_index','Derived','range_break','Range Break Indices','0.001',3),
            sym('RNGBULL200','Range Break 200 Index Bull', 'synthetic_index','Derived','range_break','Range Break Indices','0.001',3),
            sym('frxEURUSD','EUR/USD','forex','Forex','major_pairs','Major Pairs','0.00001',5),
            sym('frxGBPUSD','GBP/USD','forex','Forex','major_pairs','Major Pairs','0.00001',5),
            sym('frxUSDJPY','USD/JPY','forex','Forex','major_pairs','Major Pairs','0.001',  3),
            sym('frxAUDUSD','AUD/USD','forex','Forex','major_pairs','Major Pairs','0.00001',5),
            sym('frxUSDCAD','USD/CAD','forex','Forex','major_pairs','Major Pairs','0.00001',5),
            sym('frxUSDCHF','USD/CHF','forex','Forex','major_pairs','Major Pairs','0.00001',5),
            sym('frxNZDUSD','NZD/USD','forex','Forex','major_pairs','Major Pairs','0.00001',5),
            // ── Forex Minor Pairs ─────────────────────────────────────────────
            sym('frxEURGBP','EUR/GBP','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxEURJPY','EUR/JPY','forex','Forex','minor_pairs','Minor Pairs','0.001',  3),
            sym('frxGBPJPY','GBP/JPY','forex','Forex','minor_pairs','Minor Pairs','0.001',  3),
            sym('frxEURAUD','EUR/AUD','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxEURCAD','EUR/CAD','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxEURCHF','EUR/CHF','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxGBPAUD','GBP/AUD','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxGBPCAD','GBP/CAD','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxGBPCHF','GBP/CHF','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxGBPNZD','GBP/NZD','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxAUDCAD','AUD/CAD','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxAUDCHF','AUD/CHF','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxAUDNZD','AUD/NZD','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxAUDJPY','AUD/JPY','forex','Forex','minor_pairs','Minor Pairs','0.001',  3),
            sym('frxNZDJPY','NZD/JPY','forex','Forex','minor_pairs','Minor Pairs','0.001',  3),
            sym('frxNZDCAD','NZD/CAD','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxNZDCHF','NZD/CHF','forex','Forex','minor_pairs','Minor Pairs','0.00001',5),
            sym('frxCADJPY','CAD/JPY','forex','Forex','minor_pairs','Minor Pairs','0.001',  3),
            sym('frxCHFJPY','CHF/JPY','forex','Forex','minor_pairs','Minor Pairs','0.001',  3),
            // ── Metals ────────────────────────────────────────────────────────
            sym('frxXAUUSD','Gold/USD',    'forex','Forex','metals','Metals','0.01',  2),
            sym('frxXAGUSD','Silver/USD',  'forex','Forex','metals','Metals','0.001', 3),
            sym('frxXPDUSD','Palladium/USD','forex','Forex','metals','Metals','0.01', 2),
            sym('frxXPTUSD','Platinum/USD','forex','Forex','metals','Metals','0.01',  2),
            // ── Cryptocurrency ────────────────────────────────────────────────
            sym('cryBTCUSD','BTC/USD', 'cryptocurrency','Crypto','crypto','Crypto','0.01',2),
            sym('cryETHUSD','ETH/USD', 'cryptocurrency','Crypto','crypto','Crypto','0.01',2),
            sym('cryLTCUSD','LTC/USD', 'cryptocurrency','Crypto','crypto','Crypto','0.01',2),
            sym('cryXRPUSD','XRP/USD', 'cryptocurrency','Crypto','crypto','Crypto','0.0001',4),
            sym('cryDOGEUSD','DOGE/USD','cryptocurrency','Crypto','crypto','Crypto','0.00001',5),
            sym('cryADAUSD','ADA/USD', 'cryptocurrency','Crypto','crypto','Crypto','0.0001',4),
            sym('crySOLUSD','SOL/USD', 'cryptocurrency','Crypto','crypto','Crypto','0.01',2),
            sym('cryDOTUSD','DOT/USD', 'cryptocurrency','Crypto','crypto','Crypto','0.001',3),
            sym('cryLINKUSD','LINK/USD','cryptocurrency','Crypto','crypto','Crypto','0.001',3),
            sym('cryBNBUSD','BNB/USD', 'cryptocurrency','Crypto','crypto','Crypto','0.01',2),
            sym('cryEOSUSD','EOS/USD', 'cryptocurrency','Crypto','crypto','Crypto','0.001',3),
            sym('cryTRXUSD','TRX/USD', 'cryptocurrency','Crypto','crypto','Crypto','0.00001',5),
            // ── Stock Indices ─────────────────────────────────────────────────
            sym('FRXUS500', 'US 500',      'indices','Stock Indices','american_OTC','American Indices','0.01',2),
            sym('FRXUS30',  'Wall St 30',  'indices','Stock Indices','american_OTC','American Indices','0.01',2),
            sym('FRXUK100', 'UK 100',      'indices','Stock Indices','europe_OTC',  'European Indices','0.01',2),
            sym('FRXDE30',  'Germany 30',  'indices','Stock Indices','europe_OTC',  'European Indices','0.01',2),
            sym('FRXFRA40', 'France 40',   'indices','Stock Indices','europe_OTC',  'European Indices','0.01',2),
            sym('FRXSPAIN35','Spain 35',   'indices','Stock Indices','europe_OTC',  'European Indices','0.01',2),
            sym('FRXHK50',  'Hong Kong 50','indices','Stock Indices','asia_OTC',    'Asian Indices',   '0.01',2),
            sym('FRXJPN225','Japan 225',   'indices','Stock Indices','asia_OTC',    'Asian Indices',   '1',   0),
            sym('FRXAUS200','Australia 200','indices','Stock Indices','asia_OTC',   'Asian Indices',   '0.1', 1),
        ],
    },
    trading_times: {
        trading_times: {
            markets: [
                {
                    name: 'Derived',
                    submarkets: [
                        { name: 'Continuous Indices',  symbols: ['R_10','R_25','R_50','R_75','R_100','stpRNG'].map(s => ttSym(s, s)) },
                        { name: '1 Second Indices',    symbols: ['1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V'].map(s => ttSym(s, s)) },
                        { name: 'Daily Reset Indices', symbols: ['BOOM300N','BOOM500','BOOM1000','CRASH300N','CRASH500','CRASH1000'].map(s => ttSym(s, s)) },
                        { name: 'Jump Indices',        symbols: ['JD10','JD25','JD50','JD75','JD100','JD150','JD200'].map(s => ttSym(s, s)) },
                        { name: 'Range Break Indices', symbols: ['RNGBEAR200','RNGBULL200'].map(s => ttSym(s, s)) },
                    ],
                },
                {
                    name: 'Forex',
                    submarkets: [
                        { name: 'Major Pairs', symbols: [
                            ttSym('frxEURUSD','EUR/USD',WEEKDAYS), ttSym('frxGBPUSD','GBP/USD',WEEKDAYS),
                            ttSym('frxUSDJPY','USD/JPY',WEEKDAYS), ttSym('frxAUDUSD','AUD/USD',WEEKDAYS),
                            ttSym('frxUSDCAD','USD/CAD',WEEKDAYS), ttSym('frxUSDCHF','USD/CHF',WEEKDAYS),
                            ttSym('frxNZDUSD','NZD/USD',WEEKDAYS),
                        ]},
                        { name: 'Minor Pairs', symbols: [
                            ttSym('frxEURGBP','EUR/GBP',WEEKDAYS), ttSym('frxEURJPY','EUR/JPY',WEEKDAYS),
                            ttSym('frxGBPJPY','GBP/JPY',WEEKDAYS), ttSym('frxEURAUD','EUR/AUD',WEEKDAYS),
                            ttSym('frxEURCAD','EUR/CAD',WEEKDAYS), ttSym('frxEURCHF','EUR/CHF',WEEKDAYS),
                            ttSym('frxGBPAUD','GBP/AUD',WEEKDAYS), ttSym('frxGBPCAD','GBP/CAD',WEEKDAYS),
                            ttSym('frxGBPCHF','GBP/CHF',WEEKDAYS), ttSym('frxGBPNZD','GBP/NZD',WEEKDAYS),
                            ttSym('frxAUDCAD','AUD/CAD',WEEKDAYS), ttSym('frxAUDCHF','AUD/CHF',WEEKDAYS),
                            ttSym('frxAUDNZD','AUD/NZD',WEEKDAYS), ttSym('frxAUDJPY','AUD/JPY',WEEKDAYS),
                            ttSym('frxNZDJPY','NZD/JPY',WEEKDAYS), ttSym('frxNZDCAD','NZD/CAD',WEEKDAYS),
                            ttSym('frxNZDCHF','NZD/CHF',WEEKDAYS), ttSym('frxCADJPY','CAD/JPY',WEEKDAYS),
                            ttSym('frxCHFJPY','CHF/JPY',WEEKDAYS),
                        ]},
                        { name: 'Metals', symbols: [
                            ttSym('frxXAUUSD','Gold/USD',    WEEKDAYS),
                            ttSym('frxXAGUSD','Silver/USD',  WEEKDAYS),
                            ttSym('frxXPDUSD','Palladium/USD',WEEKDAYS),
                            ttSym('frxXPTUSD','Platinum/USD',WEEKDAYS),
                        ]},
                    ],
                },
                {
                    name: 'Crypto',
                    submarkets: [
                        { name: 'Crypto', symbols: [
                            ttSym('cryBTCUSD','BTC/USD'), ttSym('cryETHUSD','ETH/USD'),
                            ttSym('cryLTCUSD','LTC/USD'), ttSym('cryXRPUSD','XRP/USD'),
                            ttSym('cryDOGEUSD','DOGE/USD'), ttSym('cryADAUSD','ADA/USD'),
                            ttSym('crySOLUSD','SOL/USD'), ttSym('cryDOTUSD','DOT/USD'),
                            ttSym('cryLINKUSD','LINK/USD'), ttSym('cryBNBUSD','BNB/USD'),
                            ttSym('cryEOSUSD','EOS/USD'), ttSym('cryTRXUSD','TRX/USD'),
                        ]},
                    ],
                },
                {
                    name: 'Stock Indices',
                    submarkets: [
                        { name: 'American Indices', symbols: [
                            ttSym('FRXUS500','US 500',WEEKDAYS), ttSym('FRXUS30','Wall St 30',WEEKDAYS),
                        ]},
                        { name: 'European Indices', symbols: [
                            ttSym('FRXUK100','UK 100',WEEKDAYS), ttSym('FRXDE30','Germany 30',WEEKDAYS),
                            ttSym('FRXFRA40','France 40',WEEKDAYS), ttSym('FRXSPAIN35','Spain 35',WEEKDAYS),
                        ]},
                        { name: 'Asian Indices', symbols: [
                            ttSym('FRXHK50','Hong Kong 50',WEEKDAYS),
                            ttSym('FRXJPN225','Japan 225',WEEKDAYS),
                            ttSym('FRXAUS200','Australia 200',WEEKDAYS),
                        ]},
                    ],
                },
            ],
        },
    },
};

// ── DCirclesPanel ─────────────────────────────────────────────────────────────
// Fully self-contained — manages its own digit state.
// Lives OUTSIDE SmartChart so tick updates never trigger a chart re-render.
// Wrapped in React.memo: only re-renders when symbol or isMobile changes.

interface DCirclesPanelProps {
    symbol: string;
    isMobile: boolean;
}

const DCirclesPanel = memo(({ symbol, isMobile }: DCirclesPanelProps) => {
    const [digits, setDigits] = useState<number[]>(() => {
        try {
            const saved = localStorage.getItem('digitsMap');
            if (saved) {
                const map = JSON.parse(saved) as Record<string, number[]>;
                const s = localStorage.getItem('dc_symbol') || 'R_75';
                return map[s] || [];
            }
        } catch {}
        return [];
    });

    const [displayCount, setDisplayCount] = useState<number>(() => {
        const saved = localStorage.getItem('digits_display_count');
        return saved ? Number(saved) : 100;
    });

    const [inputValue, setInputValue] = useState<string>(() => {
        return localStorage.getItem('digits_display_count') ?? '100';
    });

    const [isEditing, setIsEditing] = useState(false);

    const visibleDigits = useMemo(() => digits.slice(-displayCount), [digits, displayCount]);

    useEffect(() => {
        setDigits(globalTickEngine.getDigits(symbol));
        const unsub = globalTickEngine.subscribe((sym: string, d: number[]) => {
            if (sym === symbol) setDigits(d);
        });
        return unsub;
    }, [symbol]);

    useEffect(() => {
        localStorage.setItem('digits_display_count', String(displayCount));
    }, [displayCount]);

    useEffect(() => {
        if (!isEditing) setInputValue(String(displayCount));
    }, [displayCount, isEditing]);

    return (
        <>
            {/* DigitCircles panel */}
            <div
                style={{
                    position: 'absolute',
                    bottom: 41,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    zIndex: 10,
                    pointerEvents: 'none',
                }}
            >
                <div
                    style={{
                        background: 'rgba(0,0,0,0.6)',
                        padding: '6px 10px',
                        borderRadius: '10px',
                        transform: isMobile ? 'scale(0.68)' : 'scale(1)',
                        transformOrigin: 'bottom center',
                    }}
                >
                    <DigitCircles digits={visibleDigits} />
                </div>
            </div>

            {/* Digits-to-show input (desktop only) */}
            {!isMobile && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 160,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 20,
                        pointerEvents: 'all',
                    }}
                >
                    <div style={{ textAlign: 'center', marginBottom: '4px', color: '#ccc', fontSize: '12px' }}>
                        Digits to show
                    </div>
                    <input
                        type="number"
                        value={inputValue}
                        onFocus={() => setIsEditing(true)}
                        onChange={e => {
                            const val = e.target.value;
                            if (val === '') { setInputValue(''); return; }
                            if (!/^\d+$/.test(val)) return;
                            setInputValue(val);
                            setDisplayCount(Number(val));
                        }}
                        onKeyDown={e => {
                            if (e.key === 'Enter') {
                                let val = Number(inputValue);
                                if (isNaN(val)) val = 100;
                                val = Math.min(3000, Math.max(10, val));
                                setDisplayCount(val);
                                setInputValue(String(val));
                                setIsEditing(false);
                                (e.target as HTMLInputElement).blur();
                            }
                        }}
                        onBlur={() => {
                            let val = Number(inputValue);
                            if (isNaN(val)) val = 100;
                            val = Math.min(3000, Math.max(10, val));
                            setDisplayCount(val);
                            setInputValue(String(val));
                            setIsEditing(false);
                        }}
                        style={{
                            padding: '8px 12px',
                            borderRadius: '10px',
                            border: '1px solid #00ffcc',
                            background: '#111',
                            color: '#00ffcc',
                            fontWeight: 600,
                            width: '100px',
                            textAlign: 'center',
                        }}
                    />
                </div>
            )}
        </>
    );
});
DCirclesPanel.displayName = 'DCirclesPanel';

// ── Chart ─────────────────────────────────────────────────────────────────────

const Chart = observer(({ show_digits_stats }: { show_digits_stats: boolean }) => {
    const { common, ui, chart_store, run_panel, dashboard } = useStore();

    const {
        chart_type,
        getMarketsOrder,
        granularity,
        onSymbolChange,
        setChartStatus,
        symbol,
        updateChartType,
        updateGranularity,
        updateSymbol,
    } = chart_store;

    const { isDesktop, isMobile } = useDevice();
    const { is_drawer_open } = run_panel;
    const { is_chart_modal_visible } = dashboard;

    const [isSafari, setIsSafari] = useState(false);

    useEffect(() => {
        const ua = navigator.userAgent.toLowerCase();
        setIsSafari(ua.includes('safari') && !ua.includes('chrome') && !ua.includes('android'));
        return () => {
            ChartDataLayer.cancelCurrent();
        };
    }, []);

    useEffect(() => {
        if (!chart_store.symbol || chart_store.symbol === 'undefined') {
            chart_store.updateSymbol();
        }
    }, []);

    // ── API WRAPPER ───────────────────────────────────────────────────────────
    // Tier 1: UNSUPPORTED_MOCKS — returned instantly, never touch any WS.
    // Tier 2: Everything else — routed through PublicMarketSocket (no auth).
    const requestAPI = useCallback((req: Record<string, unknown>) => {
        const mockKey = Object.keys(req).find(k => k in UNSUPPORTED_MOCKS);
        if (mockKey) {
            return Promise.resolve(UNSUPPORTED_MOCKS[mockKey]);
        }

        if ('ticks_history' in req && (!req.ticks_history || req.ticks_history === 'undefined')) {
            return Promise.reject(new Error('Invalid symbol request blocked'));
        }

        // Use the PUBLIC socket — no auth token, no private WS
        const socket = PublicMarketSocket.getSocket();
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('Public WS not connected'));
        }

        return new Promise<unknown>((resolve, reject) => {
            const reqId = 80000 + Math.floor(Math.random() * 9_000);
            const fullReq = { ...req, req_id: reqId };

            const handler = (evt: MessageEvent) => {
                try {
                    const msg = JSON.parse(evt.data as string) as Record<string, unknown>;
                    if (msg?.req_id === reqId) {
                        socket.removeEventListener('message', handler);
                        clearTimeout(timeout);
                        resolve(msg);
                    }
                } catch {}
            };

            const timeout = setTimeout(() => {
                socket.removeEventListener('message', handler);
                reject(new Error('requestAPI timeout'));
            }, 30_000);

            socket.addEventListener('message', handler);
            socket.send(JSON.stringify(fullReq));
        });
    }, []);

    const requestForget = useCallback((id: string) => {
        ChartDataLayer.requestForget(id);
    }, []);

    const requestForgetStream = useCallback((id: string) => {
        ChartDataLayer.requestForgetStream(id);
    }, []);

    // requestSubscribe — delegates entirely to ChartDataLayer.
    // No auth check, no WS readiness check — ChartDataLayer handles both transparently.
    const requestSubscribe = useCallback(
        (req: TicksStreamRequest, callback: (data: unknown) => void) => {
            ChartDataLayer.requestSubscribe(req as Record<string, unknown>, callback);
        },
        []
    );

    const toolbarWidget = useCallback(
        () => (
            <ToolbarWidgets
                updateChartType={updateChartType}
                updateGranularity={updateGranularity}
                position={!isDesktop ? 'bottom' : 'top'}
                isDesktop={isDesktop}
            />
        ),
        [isDesktop, updateChartType, updateGranularity]
    );

    const topWidgets = useCallback(
        () => <ChartTitle onChange={onSymbolChange} />,
        [onSymbolChange]
    );

    const settings = useMemo(
        () => ({
            assetInformation: false,
            countdown: true,
            isHighestLowestMarkerEnabled: false,
            language: common.current_language.toLowerCase(),
            position: ui.is_chart_layout_default ? 'bottom' : 'left',
            theme: ui.is_dark_mode_on ? 'dark' : 'light',
        }),
        [common.current_language, ui.is_chart_layout_default, ui.is_dark_mode_on]
    );

    const barriers = useMemo(() => [], []);

    // Hard-guard — SmartChart must NEVER receive undefined/empty/'undefined'
    const resolvedSymbol =
        typeof symbol === 'string' && symbol.trim() && symbol !== 'undefined'
            ? symbol
            : 'R_100';

    return (
        <div
            style={{ position: 'relative', minHeight: '400px' }}
        >
            {/* ── SmartChart wrapper ───────────────────────────────────────────
                SmartChart lives here ALONE. No auth, no digit state, no ticks.
                DCirclesPanel is rendered BELOW — completely separate DOM layer. */}
            <div
                className={classNames('dashboard__chart-wrapper', {
                    'dashboard__chart-wrapper--expanded': is_drawer_open && isDesktop,
                    'dashboard__chart-wrapper--modal':    is_chart_modal_visible && isDesktop,
                    'dashboard__chart-wrapper--safari':   isSafari,
                })}
            >
                <ChartConnectionBadge />

                {/* SmartChart renders unconditionally — no auth gate.
                    isConnectionOpened=true because ChartDataLayer always delivers
                    data (preview mock or live WS — transparent to SmartChart). */}
                <SmartChart
                    id="dbot"
                    barriers={barriers}
                    showLastDigitStats={show_digits_stats}
                    chartControlsWidgets={null}
                    enabledChartFooter={false}
                    chartStatusListener={(v: boolean) => setChartStatus(!v)}
                    toolbarWidget={toolbarWidget}
                    chartType={chart_type}
                    isMobile={isMobile}
                    enabledNavigationWidget={isDesktop}
                    granularity={granularity}
                    requestAPI={requestAPI}
                    requestForget={requestForget}
                    requestForgetStream={requestForgetStream}
                    requestSubscribe={requestSubscribe}
                    settings={settings}
                    symbol={resolvedSymbol}
                    topWidgets={topWidgets}
                    isConnectionOpened={true}
                    getMarketsOrder={getMarketsOrder}
                    isLive
                    leftMargin={80}
                    priceFormatter={(price: number) => {
                        const formatted = String(price);
                        const digitStream = formatted.replace('.', '');
                        const digit = Number(digitStream.slice(-1));
                        return `${formatted} • ${digit}`;
                    }}
                />
            </div>

            {/* ── DCircles layer ───────────────────────────────────────────────
                Floating, draggable, resizable overlay — stays outside SmartChart
                so tick updates never cause a chart re-render. Position/size are
                persisted in localStorage; pointer-events on the chart wrapper are
                toggled off/on during drag to prevent SmartCharts pan/zoom. */}
            <FloatingDCirclesWidget symbol={resolvedSymbol} isMobile={isMobile} />
        </div>
    );
});

export default Chart;
