import { useEffect, useState } from 'react';
import { PublicTickManager, PublicTick } from '@/utils/PublicTickManager';

export const useDerivTicks = (symbol: string) => {
    const [tick, setTick] = useState<PublicTick | null>(null);

    useEffect(() => {
        if (!symbol) return;

        const unsub = PublicTickManager.subscribe(symbol, incoming => {
            setTick({ ...incoming });
        });

        return unsub;
    }, [symbol]);

    return tick;
};
