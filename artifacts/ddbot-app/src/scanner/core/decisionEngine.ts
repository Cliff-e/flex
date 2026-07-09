export const shouldTrade = (probability: number, minWinRate: number) => {
    return probability >= minWinRate;
};