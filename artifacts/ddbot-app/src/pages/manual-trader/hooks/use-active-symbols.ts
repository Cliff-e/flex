import { useEffect, useRef, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';

export type ActiveSymbol = {
    symbol: string;
    display_name: string;
    market: string;
    market_display_name: string;
    submarket: string;
    submarket_display_name: string;
    pip: string;
    is_trading_suspended: number;
    exchange_is_open: number;
};

const FALLBACK_SYMBOLS: ActiveSymbol[] = [
    { symbol: 'R_10',      display_name: 'Volatility 10 Index',        market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index',    submarket_display_name: 'Continuous Indices',  pip: '0.001',   is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'R_25',      display_name: 'Volatility 25 Index',        market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index',    submarket_display_name: 'Continuous Indices',  pip: '0.001',   is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'R_50',      display_name: 'Volatility 50 Index',        market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index',    submarket_display_name: 'Continuous Indices',  pip: '0.0001',  is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'R_75',      display_name: 'Volatility 75 Index',        market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index',    submarket_display_name: 'Continuous Indices',  pip: '0.0001',  is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'R_100',     display_name: 'Volatility 100 Index',       market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index',    submarket_display_name: 'Continuous Indices',  pip: '0.01',    is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: '1HZ10V',    display_name: 'Volatility 10 (1s) Index',   market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index_s1', submarket_display_name: '1 Second Indices',    pip: '0.0001',  is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: '1HZ25V',    display_name: 'Volatility 25 (1s) Index',   market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index_s1', submarket_display_name: '1 Second Indices',    pip: '0.0001',  is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: '1HZ50V',    display_name: 'Volatility 50 (1s) Index',   market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index_s1', submarket_display_name: '1 Second Indices',    pip: '0.00001', is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: '1HZ75V',    display_name: 'Volatility 75 (1s) Index',   market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index_s1', submarket_display_name: '1 Second Indices',    pip: '0.00001', is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: '1HZ100V',   display_name: 'Volatility 100 (1s) Index',  market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index_s1', submarket_display_name: '1 Second Indices',    pip: '0.001',   is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'BOOM300N',  display_name: 'Boom 300 Index',             market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_daily',    submarket_display_name: 'Daily Reset Indices', pip: '0.0001',  is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'BOOM500',   display_name: 'Boom 500 Index',             market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_daily',    submarket_display_name: 'Daily Reset Indices', pip: '0.0001',  is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'BOOM1000',  display_name: 'Boom 1000 Index',            market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_daily',    submarket_display_name: 'Daily Reset Indices', pip: '0.0001',  is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'CRASH300N', display_name: 'Crash 300 Index',            market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_daily',    submarket_display_name: 'Daily Reset Indices', pip: '0.0001',  is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'CRASH500',  display_name: 'Crash 500 Index',            market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_daily',    submarket_display_name: 'Daily Reset Indices', pip: '0.0001',  is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'CRASH1000', display_name: 'Crash 1000 Index',           market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_daily',    submarket_display_name: 'Daily Reset Indices', pip: '0.0001',  is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'JD10',      display_name: 'Jump 10 Index',              market: 'synthetic_index', market_display_name: 'Derived', submarket: 'jump_index',      submarket_display_name: 'Jump Indices',        pip: '0.01',    is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'JD25',      display_name: 'Jump 25 Index',              market: 'synthetic_index', market_display_name: 'Derived', submarket: 'jump_index',      submarket_display_name: 'Jump Indices',        pip: '0.01',    is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'JD50',      display_name: 'Jump 50 Index',              market: 'synthetic_index', market_display_name: 'Derived', submarket: 'jump_index',      submarket_display_name: 'Jump Indices',        pip: '0.01',    is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'JD75',      display_name: 'Jump 75 Index',              market: 'synthetic_index', market_display_name: 'Derived', submarket: 'jump_index',      submarket_display_name: 'Jump Indices',        pip: '0.01',    is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'JD100',     display_name: 'Jump 100 Index',             market: 'synthetic_index', market_display_name: 'Derived', submarket: 'jump_index',      submarket_display_name: 'Jump Indices',        pip: '0.01',    is_trading_suspended: 0, exchange_is_open: 1 },
    { symbol: 'stpRNG',    display_name: 'Step Index',                 market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index',    submarket_display_name: 'Continuous Indices',  pip: '0.1',     is_trading_suspended: 0, exchange_is_open: 1 },
];

export const useActiveSymbols = () => {
    const { isAuthorized } = useApiBase();
    const [symbols, setSymbols] = useState<ActiveSymbol[]>(FALLBACK_SYMBOLS);
    const [isLoading, setIsLoading] = useState(false);
    const fetchedRef = useRef(false);

    useEffect(() => {
        if (!isAuthorized || !api_base.api || fetchedRef.current) return;

        fetchedRef.current = true;
        setIsLoading(true);

        const sub = api_base.api.onMessage().subscribe(({ data }: any) => {
            if (data?.msg_type === 'active_symbols') {
                const list: ActiveSymbol[] = (data.active_symbols ?? []).filter(
                    (s: ActiveSymbol) => s.exchange_is_open === 1 && s.is_trading_suspended === 0
                );
                if (list.length > 0) setSymbols(list);
                setIsLoading(false);
                sub.unsubscribe();
            }
        });

        try {
            (api_base.api as any).send({ active_symbols: 'brief', product_type: 'basic' });
        } catch {
            setIsLoading(false);
            sub.unsubscribe();
        }

        return () => sub.unsubscribe();
    }, [isAuthorized]);

    const grouped = symbols.reduce<Record<string, ActiveSymbol[]>>((acc, s) => {
        const key = s.submarket_display_name || s.market_display_name;
        if (!acc[key]) acc[key] = [];
        acc[key].push(s);
        return acc;
    }, {});

    return { symbols, grouped, isLoading };
};
