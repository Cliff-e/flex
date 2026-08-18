import { useEffect, useState } from 'react';
import { PublicTickManager } from '@/utils/PublicTickManager';

export const useDigits = (symbol: string) => {
    const [digits, setDigits] = useState<number[]>(() => {
        try {
            const saved = localStorage.getItem('digits');
            return saved ? JSON.parse(saved) : [];
        } catch {
            return [];
        }
    });

    useEffect(() => {
        if (!symbol) return;

        const unsub = PublicTickManager.subscribe(symbol, tick => {
            const digit = Math.floor(tick.quote * 10) % 10;
            setDigits(prev => {
                const updated = [...prev.slice(-1000), digit];
                try { localStorage.setItem('digits', JSON.stringify(updated)); } catch {}
                return updated;
            });
        });

        return unsub;
    }, [symbol]);

    return digits;
};
