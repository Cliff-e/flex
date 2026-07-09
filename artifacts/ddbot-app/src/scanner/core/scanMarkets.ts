const precisionMap: Record<string, number> = {};

export const scanMarkets = (
    symbols: string[],
    tickMap: any,
    ticks: number,
    strategy: any,
    runStrategy: any
) => {
    let best: any = null;

    symbols.forEach(symbol => {
        const raw = tickMap[symbol];

        // ❌ skip invalid safely (NO return null)
        if (!raw) return;

        // 🔥 normalize
        let ticksArray: (number | string)[] = [];

        if (Array.isArray(raw)) {
            ticksArray = raw;
        } else if (Array.isArray(raw.history)) {
            ticksArray = raw.history;
        } else if (Array.isArray(raw.prices)) {
            ticksArray = raw.prices;
        } else {
            console.warn('⚠️ Bad tick format for', symbol, raw);
            return;
        }

        // ✅ slice AFTER normalization
        const sliced = ticksArray.slice(-ticks);

        if (!sliced.length) return;

        // ✅ run strategy correctly
       const result = runStrategy(
    strategy,
    sliced,        // already sliced ticks
    symbol,
    precisionMap,
    ticks          // 👈 THIS is your lookback
);

        if (!result) return;

        // ⚠️ fallback if confidence missing
        let prob = result.confidence ?? result.probability ?? 0;

        // ⚠️ market adjustments
        if (symbol.includes('1HZ')) prob -= 5;
        if (symbol.includes('JD')) prob -= 10;

        if (!best || prob > best.probability) {
            best = {
                symbol,
                probability: prob,
                result
            };
        }
    });

    return best;
};