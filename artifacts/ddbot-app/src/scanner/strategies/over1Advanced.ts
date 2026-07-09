import { getLastDigits } from '../utils/digits';

export const over1Advanced = (
    ticks: (number | string)[],
    symbol: string,
    precisionMap: Record<string, number>,
    lookback: number
) => {
    if (!ticks || ticks.length < lookback) return null;

    const digits = getLastDigits(ticks, symbol, precisionMap);
    const window = digits.slice(-lookback);

    // 🔹 0 & 1 frequency
    const lowCount = window.filter(d => d === 0 || d === 1).length;
    const lowPercent = (lowCount / window.length) * 100;

    if (lowPercent >= 10.5) return null;

    // 🔹 no "red bar" (spike filter)
    const recentSize = Math.min(50, Math.floor(lookback * 0.05));
    const recent = window.slice(-recentSize);

    const recentLow = recent.filter(d => d === 0 || d === 1).length;
    const recentPercent = (recentLow / recent.length) * 100;

    if (recentPercent > lowPercent * 1.5) return null;

    // 🔹 entry digit
    const lastDigit = window[window.length - 1];

    if (lastDigit !== 5 && lastDigit !== 6) return null;

    return {
        contract: 'DIGITOVER',
        barrier: 1,
        probability: 75,
        meta: {
            entryDigit: lastDigit,
            lowPercent
        }
    };
};