export const getFrequencyMap = (digits: number[]) => {
    const map: Record<number, number> = {};

    digits.forEach(d => {
        map[d] = (map[d] || 0) + 1;
    });

    return map;
};

// check if 4-digit cycle repeats pattern
export const detectCyclePattern = (digits: number[]) => {
    if (digits.length < 20) return false;

    const last4 = digits.slice(-4).join('');
    const previous = digits.slice(-12, -8).join('');

    return last4 === previous;
};