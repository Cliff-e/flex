export const analyzeTicks = (ticks: number[], strategy: string) => {
    if (ticks.length < 20) return null;

    let wins = 0;

    ticks.forEach(t => {
        const digit = Number(t.toString().slice(-1));

        switch (strategy) {
            case 'over1':
                if (digit > 1) wins++;
                break;
            case 'over2':
                if (digit > 2) wins++;
                break;
            case 'over3':
                if (digit > 3) wins++;
                break;
            case 'evenodd':
                if (digit % 2 === 0) wins++;
                break;
            case 'differ':
                if (digit !== 5) wins++;
                break;
        }
    });

    return (wins / ticks.length) * 100;
};