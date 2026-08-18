import { useEffect, useState } from 'react';
import { PublicTickManager } from '@/utils/PublicTickManager';

export const useMultiTicks = (symbols: string[]) => {
    const [tickMap, setTickMap] = useState<Record<string, number[]>>({});

    useEffect(() => {
        if (!symbols.length) return;

        const unsubs = symbols.map(symbol =>
            PublicTickManager.subscribe(symbol, tick => {
                setTickMap(prev => ({
                    ...prev,
                    [symbol]: [...(prev[symbol] || []), tick.quote].slice(-100),
                }));
            })
        );

        return () => unsubs.forEach(fn => fn());
    }, [symbols.join(',')]);

    return tickMap;
};
