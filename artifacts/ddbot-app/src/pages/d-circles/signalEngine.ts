export type Signal = {
    type: 'HOT' | 'COLD' | 'OVER' | 'UNDER' | null;
    digit?: number;
    strength?: number;
    message: string;
};

export const analyzeSignals = (freq: Record<number, number>, total: number): Signal[] => {
    const signals: Signal[] = [];

    if (!total) return signals;

    const percentages = Object.entries(freq).map(([d, count]) => ({
        digit: Number(d),
        pct: (count / total) * 100
    }));

    // 🔥 HOT DIGIT (dominant)
    const hot = percentages.find(p => p.pct >= 13); // threshold
    if (hot) {
        signals.push({
            type: 'HOT',
            digit: hot.digit,
            strength: hot.pct,
            message: `🔥 Digit ${hot.digit} is HOT (${hot.pct.toFixed(1)}%)`
        });
    }

    // ❄️ COLD DIGIT (rare)
    const cold = percentages.find(p => p.pct <= 7);
    if (cold) {
        signals.push({
            type: 'COLD',
            digit: cold.digit,
            strength: cold.pct,
            message: `❄️ Digit ${cold.digit} is COLD (${cold.pct.toFixed(1)}%)`
        });
    }

    // ⚖️ OVER / UNDER
    const over = percentages
        .filter(p => p.digit >= 5)
        .reduce((a, b) => a + b.pct, 0);

    const under = percentages
        .filter(p => p.digit < 5)
        .reduce((a, b) => a + b.pct, 0);

    if (over >= 55) {
        signals.push({
            type: 'OVER',
            strength: over,
            message: `📈 OVER dominant (${over.toFixed(1)}%)`
        });
    }

    if (under >= 55) {
        signals.push({
            type: 'UNDER',
            strength: under,
            message: `📉 UNDER dominant (${under.toFixed(1)}%)`
        });
    }

    return signals;
};