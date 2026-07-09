import { useEffect, useState } from 'react';
import { PublicTickManager } from '@/utils/PublicTickManager';

type MarketState = {
    digits: number[];
    lastDigit: number;
};

const useMultiMarketScanner = (symbols: string[]) => {
    const [markets, setMarkets] = useState<Record<string, MarketState>>({});

    useEffect(() => {
        if (!symbols.length) return;

        const unsubs = symbols.map(symbol =>
            PublicTickManager.subscribe(symbol, tick => {
                const str = tick.quote.toFixed(10);
                const decLen = (str.split('.')[1] || '').length;
                const digit = Number(tick.quote.toFixed(Math.max(decLen, 2)).slice(-1));

                setMarkets(prev => ({
                    ...prev,
                    [symbol]: {
                        digits: [...(prev[symbol]?.digits || []).slice(-2999), digit],
                        lastDigit: digit,
                    },
                }));
            })
        );

        return () => unsubs.forEach(fn => fn());
    }, [symbols.join(',')]);

    return markets;
};

export default useMultiMarketScanner;
