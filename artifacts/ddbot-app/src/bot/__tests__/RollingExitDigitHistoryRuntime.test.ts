import { getVHTransactionPipeline, resetVHRuntime } from '../virtualHook/VHRuntime';
import type { VirtualContract } from '../virtualHook/VirtualContract';
import {
    appendExitDigit,
    clearExitDigitHistory,
    getExitDigitCount,
    getLastNDigits,
    resetExitDigitHistory,
} from '../sharedExitDigitHistory';
import getBotInterface from '../../external/bot-skeleton/services/tradeEngine/Interface/BotInterface';

const makeSettledContract = (contractId: string, exitDigit: number): VirtualContract => ({
    contractId,
    runId: 'runtime-test',
    roundIndex: 0,
    candidate: {
        signalId: `signal-${contractId}`,
        source: 'xml',
        contractType: 'DIGITOVER',
        symbol: 'R_100',
        realStake: 1,
        duration: 1,
        durationUnit: 't',
        currency: 'USD',
        basis: 'stake',
        prediction: null,
        tradeParams: {},
        generatedAt: 1,
    },
    proposalId: `proposal-${contractId}`,
    askPrice: 1,
    virtualStake: 1,
    derivContractId: null,
    createdAt: 1,
    entryAt: 1,
    entryTick: 1,
    entryDigit: 1,
    settledAt: 2,
    exitTick: exitDigit,
    exitDigit,
    settlement: {
        won: true,
        source: 'api',
        rawContract: null,
        settledAt: 2,
    },
    status: 'SETTLED',
    durationMs: 1,
    timeoutAt: 2,
});

const getRollingHistoryFromBot = () => {
    const bot = getBotInterface({}) as { getRollingExitDigitHistory: () => number[] };
    return bot.getRollingExitDigitHistory();
};

const getHistoryAccessorsFromBot = () => {
    return getBotInterface({}) as {
        getExitDigitList: () => number[];
        getRollingExitDigitHistory: () => number[];
        getExitDigitAt: (position: number) => number | null;
        getLastExitDigit: () => number | null;
        getExitDigitCount: () => number;
        clearExitDigitHistory: () => void;
    };
};

describe('21 Rolling Exit Digit History production runtime chain', () => {
    beforeEach(() => {
        resetVHRuntime();
        resetExitDigitHistory();
        // resetVHRuntime disarms the lazy runtime; the next reset re-arms it.
        resetExitDigitHistory();
    });

    afterEach(() => {
        resetVHRuntime();
    });

    test('settled VH contract flows through the production pipeline to the XML Bot interface', async () => {
        appendExitDigit({ digit: 1, source: 'REAL', contractId: 'real-1', won: true, ts: 1 });
        appendExitDigit({ digit: 2, source: 'REAL', contractId: 'real-2', won: true, ts: 2 });
        appendExitDigit({ digit: 3, source: 'REAL', contractId: 'real-3', won: true, ts: 3 });

        await getVHTransactionPipeline().process(makeSettledContract('vh-settled-7', 7));

        expect(getRollingHistoryFromBot()).toEqual([1, 2, 3, 7]);
    });

    test('settling a new contract drops only the oldest value at the 21-entry boundary', async () => {
        for (let digit = 0; digit < 21; digit++) {
            appendExitDigit({
                digit,
                source: 'REAL',
                contractId: `real-boundary-${digit}`,
                won: true,
                ts: digit,
            });
        }

        await getVHTransactionPipeline().process(makeSettledContract('vh-boundary-7', 7));

        expect(getRollingHistoryFromBot()).toEqual([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 7,
        ]);
        expect(getRollingHistoryFromBot()).toHaveLength(21);
    });

    test('unsettled virtual contracts do not add an exit digit', async () => {
        const openContract = makeSettledContract('vh-open', 7);
        openContract.status = 'WAITING_SETTLEMENT';
        openContract.settledAt = null;
        openContract.exitTick = null;
        openContract.exitDigit = null;
        openContract.settlement = null;

        await getVHTransactionPipeline().process(openContract);

        expect(getRollingHistoryFromBot()).toEqual([]);
        expect(getLastNDigits(21)).toEqual([]);
    });

    test.each([0, 1, 20, 21, 22, 25])(
        'history accessors preserve chronological data at %i entries',
        count => {
            const digits = Array.from({ length: count }, (_, index) => index % 10);
            digits.forEach((digit, index) => {
                appendExitDigit({
                    digit,
                    source: 'REAL',
                    contractId: `accessor-${index}`,
                    won: true,
                    ts: index,
                });
            });


            const bot = getHistoryAccessorsFromBot();
            expect(bot.getExitDigitCount()).toBe(count);
            expect(bot.getExitDigitList()).toEqual(digits);
            expect(bot.getRollingExitDigitHistory()).toEqual(digits.slice(-21));
            expect(bot.getLastExitDigit()).toBe(count ? digits[count - 1] : null);

            for (let position = 1; position <= 25; position++) {
                const expected = position <= count ? digits[count - position] : null;
                expect(bot.getExitDigitAt(position)).toBe(expected);
            }
        }
    );

    test('clear history is synchronous and leaves an empty snapshot', () => {
        appendExitDigit({ digit: 7, source: 'REAL', contractId: 'clear-1', won: true, ts: 1 });

        const bot = getHistoryAccessorsFromBot();
        expect(() => bot.clearExitDigitHistory()).not.toThrow();
        expect(getExitDigitCount()).toBe(0);
        expect(bot.getExitDigitList()).toEqual([]);
        expect(bot.getExitDigitAt(1)).toBeNull();
    });
});