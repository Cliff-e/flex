import { useEffect, useRef, useState } from 'react';
import { PublicTickManager } from '@/utils/PublicTickManager';

type Candle = {
    open: number;
    high: number;
    low: number;
    close: number;
    epoch: number;
};

export const useDerivEngine = (symbol = 'R_100', candleSize = 5) => {
    const [ticks, setTicks] = useState<number[]>([]);
    const [candles, setCandles] = useState<Candle[]>([]);
    const currentCandle = useRef<Candle | null>(null);

    useEffect(() => {
        if (!symbol) return;

        const unsub = PublicTickManager.subscribe(symbol, tick => {
            const price = tick.quote;
            const digit = Math.floor(price * 10) % 10;
            const epoch = tick.epoch;

            setTicks(prev => {
                const updated = [...prev, digit];
                if (updated.length > 1200) updated.shift();
                return updated;
            });

            const bucket = Math.floor(epoch / candleSize);

            if (!currentCandle.current || currentCandle.current.epoch !== bucket) {
                currentCandle.current = {
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    epoch: bucket,
                };
                setCandles(prev => {
                    const updated = [...prev, currentCandle.current!];
                    if (updated.length > 200) updated.shift();
                    return updated;
                });
            } else {
                const c = currentCandle.current;
                c.high = Math.max(c.high, price);
                c.low = Math.min(c.low, price);
                c.close = price;
            }
        });

        return unsub;
    }, [symbol, candleSize]);

    return { ticks, candles };
};
