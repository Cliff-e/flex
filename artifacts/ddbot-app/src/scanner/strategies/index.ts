import { evenOddEngine } from './evenodd';
import { over1Advanced } from './over1Advanced';

export type Strategy =
    | 'over1'
    | 'over2'
    | 'over3'
    | 'evenodd'
    | 'differ';

type StrategyResult = {
    contract: string;
    barrier?: number;
    probability: number;
    meta?: any;
};

export const runStrategy = (
    strategy: Strategy,
    ticks: (number | string)[],
    symbol: string,
    precisionMap: Record<string, number>,
    count: number
): StrategyResult | null => {
    // 🛑 safety guard
    if (!ticks || ticks.length === 0) return null;

    // 🎯 single source of truth (user-controlled depth)
    const data = ticks.slice(-count);

    if (data.length === 0) return null;

    switch (strategy) {

        // =========================
        // 🔥 OVER / UNDER LOGIC
        // =========================
        case 'over1':
            return over1Advanced(data, symbol, precisionMap, count);

        case 'over2':
        case 'over3':
            // 🚧 placeholder (extend later)
            return null;

        // =========================
        // ⚖️ EVEN / ODD
        // =========================
        case 'evenodd':
            return evenOddEngine(data, symbol, precisionMap);

        // =========================
        // 🔀 DIFFER
        // =========================
        case 'differ': {
            const last = data[data.length - 1];
            const digit = Number(String(last).slice(-1));

            return {
                contract: 'DIFFER',
                barrier: digit,
                probability: 50
            };
        }

        default:
            return null;
    }
};