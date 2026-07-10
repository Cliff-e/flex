// digit.ts

type PrecisionMap = Record<string, number>;

/**
 * Extract last digit from a single tick
 * (NO rounding, only padding)
 */
export const getLastDigitFromTick = (
    tick: number | string,
    symbol: string,
    precisionMap: PrecisionMap
): number => {
    const raw = String(tick);

    const precision = precisionMap[symbol] ?? 0;

    const [intPart, decPart = ''] = raw.split('.');

    const normalized =
        precision > 0
            ? `${intPart}.${decPart.padEnd(precision, '0')}`
            : intPart;

    const digitStream = normalized.replace('.', '');

    return Number(digitStream.slice(-1));
};

/**
 * Batch version (for arrays of ticks)
 */
export const getLastDigits = (
    ticks: (number | string)[],
    symbol: string,
    precisionMap: PrecisionMap
): number[] => {
    return ticks.map(tick =>
        getLastDigitFromTick(tick, symbol, precisionMap)
    );
};

/**
 * Update precision dynamically (same logic as your hook)
 */
export const updatePrecision = (
    tick: number | string,
    symbol: string,
    precisionMap: PrecisionMap,
    maxPrecision: number = 4
): number => {
    const raw = String(tick);

    const decimalPart = raw.split('.')[1] || '';
    const detectedPrecision = decimalPart.length;

    if (!precisionMap[symbol]) {
        precisionMap[symbol] = detectedPrecision;
    } else {
        precisionMap[symbol] = Math.min(
            maxPrecision,
            Math.max(precisionMap[symbol], detectedPrecision)
        );
    }

    return precisionMap[symbol];
};