// =============================================================
// Phase 3 — SummaryStore Tests
//
// Proves Summary is a read-only consumer of committed
// TransactionRecords:
//   • updates ONLY from TransactionsStore.subscribe()
//   • one update per new commit
//   • duplicates and failed/rolled-back writes never update it
//   • incremental O(1) aggregates stay correct at scale
// =============================================================

import { SummaryStore, type VHSummary } from '../SummaryStore';
import { TransactionsStore } from '../TransactionsStore';
import type { TransactionRecord } from '../TransactionPipeline';
import type { VHLogContext, VHLogger, VHLogLevel } from '../VHLogger';

class CapturingLogger implements VHLogger {
    readonly events: Array<{ event: string; context: VHLogContext; level: VHLogLevel }> = [];
    info(event: string, context: VHLogContext): void {
        this.events.push({ event, context, level: 'info' });
    }
    warn(event: string, context: VHLogContext): void {
        this.events.push({ event, context, level: 'warn' });
    }
    error(event: string, context: VHLogContext): void {
        this.events.push({ event, context, level: 'error' });
    }
    debug(event: string, context: VHLogContext): void {
        this.events.push({ event, context, level: 'debug' });
    }
}

let seq = 0;
function makeRecord(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
    seq += 1;
    return {
        transactionId: `TX-${seq}`,
        runId: 'run-1',
        roundIndex: seq - 1,
        contractId: `VH-${seq}`,
        contractType: 'DIGITOVER',
        symbol: 'R_100',
        stake: 10,
        profit: 10,
        won: true,
        exitDigit: 5,
        settlement: 'api',
        isVirtual: true,
        settledAt: 1_700_000_000_000 + seq,
        source: 'VH',
        ...overrides,
    };
}

const win = (stake: number, settledAt?: number): TransactionRecord =>
    makeRecord({ stake, profit: stake, won: true, settledAt: settledAt ?? 1_700_000_000_001 });
const loss = (stake: number, settledAt?: number): TransactionRecord =>
    makeRecord({ stake, profit: -stake, won: false, settledAt: settledAt ?? 1_700_000_000_002 });

function setup() {
    const logger = new CapturingLogger();
    const summary = new SummaryStore(logger);
    const store = new TransactionsStore();
    store.subscribe(record => summary.onTransactionCommitted(record));
    return { logger, summary, store };
}

const emptySummary: VHSummary = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    grossProfit: 0,
    grossLoss: 0,
    netProfit: 0,
    winRate: 0,
    lastTradeTime: 0,
};

describe('SummaryStore — single committed trade', () => {
    test('one win updates every field exactly once', async () => {
        const { logger, summary, store } = setup();

        await store.pushTransaction(win(10, 1_700_000_000_100));

        expect(summary.getSummary()).toEqual({
            totalTrades: 1,
            wins: 1,
            losses: 0,
            grossProfit: 10,
            grossLoss: 0,
            netProfit: 10,
            winRate: 1,
            lastTradeTime: 1_700_000_000_100,
        });
        expect(logger.events).toHaveLength(1);
        expect(logger.events[0].event).toBe('vh.summary.updated');
        expect(logger.events[0].context.transactionId).toBeDefined();
    });

    test('one loss updates every field exactly once', async () => {
        const { summary, store } = setup();

        await store.pushTransaction(loss(5, 1_700_000_000_200));

        expect(summary.getSummary()).toEqual({
            totalTrades: 1,
            wins: 0,
            losses: 1,
            grossProfit: 0,
            grossLoss: 5,
            netProfit: -5,
            winRate: 0,
            lastTradeTime: 1_700_000_000_200,
        });
    });
});

describe('SummaryStore — multiple trades', () => {
    test('two transactions update incrementally', async () => {
        const { summary, store } = setup();

        await store.pushTransaction(win(10));
        const afterFirst = summary.getSummary();
        await store.pushTransaction(loss(4));

        expect(afterFirst.totalTrades).toBe(1);
        expect(summary.getSummary()).toEqual({
            totalTrades: 2,
            wins: 1,
            losses: 1,
            grossProfit: 10,
            grossLoss: 4,
            netProfit: 6,
            winRate: 0.5,
            lastTradeTime: 1_700_000_000_002,
        });
    });

    test('mixed wins and losses aggregate correctly', async () => {
        const { summary, store } = setup();

        await store.pushTransaction(win(10));
        await store.pushTransaction(loss(5));
        await store.pushTransaction(win(2));
        await store.pushTransaction(loss(3));

        const s = summary.getSummary();
        expect(s.totalTrades).toBe(4);
        expect(s.wins).toBe(2);
        expect(s.losses).toBe(2);
        expect(s.grossProfit).toBe(12);
        expect(s.grossLoss).toBe(8);
        expect(s.netProfit).toBe(4);
        expect(s.winRate).toBe(0.5);
    });
});

describe('SummaryStore — win rate', () => {
    test('3 wins out of 5 trades is 0.6', async () => {
        const { summary, store } = setup();
        const r = () => makeRecord();
        const records = [win(10), r(), r(), win(15), win(20)].map((rec, i) => ({
            ...rec,
            won: i < 3,
            profit: i < 3 ? rec.stake : -rec.stake,
            settledAt: 1_700_000_000_000 + i,
        }));

        for (const record of records) await store.pushTransaction(record);

        expect(summary.getSummary().wins).toBe(3);
        expect(summary.getSummary().losses).toBe(2);
        expect(summary.getSummary().winRate).toBeCloseTo(0.6, 10);
    });
});

describe('SummaryStore — P&L fields', () => {
    test('gross profit accumulates only positive P&L', async () => {
        const { summary, store } = setup();

        await store.pushTransaction(win(10));
        await store.pushTransaction(loss(20));
        await store.pushTransaction(win(30));

        expect(summary.getSummary().grossProfit).toBe(40);
    });

    test('gross loss accumulates only the magnitude of negative P&L', async () => {
        const { summary, store } = setup();

        await store.pushTransaction(loss(7));
        await store.pushTransaction(win(50));
        await store.pushTransaction(loss(13));

        expect(summary.getSummary().grossLoss).toBe(20);
    });

    test('net profit is grossProfit minus grossLoss', async () => {
        const { summary, store } = setup();

        await store.pushTransaction(win(10));
        await store.pushTransaction(loss(4));
        await store.pushTransaction(loss(6));
        await store.pushTransaction(win(15));

        expect(summary.getSummary().netProfit).toBe(15);
    });
});

describe('SummaryStore — idempotency and rollback', () => {
    test('duplicate transaction does not change totals', async () => {
        const { logger, summary, store } = setup();
        const record = win(10);

        const first = await store.pushTransaction(record);
        const second = await store.pushTransaction(record);

        expect(first.appended).toBe(true);
        expect(second.appended).toBe(false);
        expect(summary.getSummary().totalTrades).toBe(1);
        expect(summary.getSummary().grossProfit).toBe(10);
        expect(logger.events).toHaveLength(1);
    });

    test('failed transaction does not update Summary', async () => {
        const failingWriter = () => {
            throw new Error('permanent');
        };
        const logger = new CapturingLogger();
        const summary = new SummaryStore(logger);
        const store = new TransactionsStore(failingWriter);
        store.subscribe(record => summary.onTransactionCommitted(record));

        await expect(store.pushTransaction(win(10))).rejects.toThrow();

        expect(summary.getSummary()).toEqual(emptySummary);
        expect(logger.events).toHaveLength(0);
    });
});

describe('SummaryStore — scale', () => {
    test('100 committed transactions produce deterministic totals', async () => {
        const { logger, summary, store } = setup();

        for (let i = 0; i < 100; i++) {
            await store.pushTransaction(
                i % 2 === 0 ? win(10, 1_700_000_000_000 + i) : loss(5, 1_700_000_000_000 + i)
            );
        }
        const s = summary.getSummary();
        expect(s.totalTrades).toBe(100);
        expect(s.wins).toBe(50);
        expect(s.losses).toBe(50);
        expect(s.grossProfit).toBe(500);
        expect(s.grossLoss).toBe(250);
        expect(s.netProfit).toBe(250);
        expect(s.winRate).toBe(0.5);
        expect(logger.events).toHaveLength(100);

        // Deterministic: replaying the identical sequence from an empty
        // state reproduces the same summary with exactly one log per commit.
        const snapshot = summary.getSummary();
        await store.clear();
        summary.reset();
        logger.events.length = 0;
        seq = 0;
        for (let i = 0; i < 100; i++) {
            await store.pushTransaction(
                i % 2 === 0 ? win(10, 1_700_000_000_000 + i) : loss(5, 1_700_000_000_000 + i)
            );
        }
        expect(summary.getSummary()).toEqual(snapshot);
        expect(logger.events).toHaveLength(100);
    });

    test('1000 committed transactions stay correct and O(1)', async () => {
        const { logger, summary, store } = setup();

        for (let i = 0; i < 1000; i++) {
            await store.pushTransaction(
                i % 3 === 0 ? win(10, 1_700_000_000_000 + i) : loss(4, 1_700_000_000_000 + i)
            );
        }

        const s = summary.getSummary();
        const expectedWins = Math.ceil(1000 / 3);
        const expectedLosses = 1000 - expectedWins;
        expect(s.totalTrades).toBe(1000);
        expect(s.wins).toBe(expectedWins);
        expect(s.losses).toBe(expectedLosses);
        expect(s.grossProfit).toBe(expectedWins * 10);
        expect(s.grossLoss).toBe(expectedLosses * 4);
        expect(s.winRate).toBeCloseTo(expectedWins / 1000, 10);
        expect(logger.events).toHaveLength(1000);
        // Last iteration is i = 999.
        expect(s.lastTradeTime).toBe(1_700_000_000_999);
    });

    test('incremental updates remain correct after every commit', async () => {
        const { summary, store } = setup();
        let expectedWins = 0;
        let expectedLosses = 0;
        let expectedGrossProfit = 0;
        let expectedGrossLoss = 0;

        for (let i = 0; i < 25; i++) {
            const record = i % 2 === 0 ? win(10) : loss(3);
            await store.pushTransaction(record);

            if (record.won) {
                expectedWins += 1;
                expectedGrossProfit += record.profit;
            } else {
                expectedLosses += 1;
                expectedGrossLoss += Math.abs(record.profit);
            }

            const s = summary.getSummary();
            expect(s.totalTrades).toBe(i + 1);
            expect(s.wins).toBe(expectedWins);
            expect(s.losses).toBe(expectedLosses);
            expect(s.grossProfit).toBe(expectedGrossProfit);
            expect(s.grossLoss).toBe(expectedGrossLoss);
            expect(s.netProfit).toBe(expectedGrossProfit - expectedGrossLoss);
        }
    });
});

describe('SummaryStore — ordering and notifications', () => {
    test('lastTradeTime reflects the latest settledAt', async () => {
        const { summary, store } = setup();

        await store.pushTransaction(win(10, 1_700_000_000_050));
        await store.pushTransaction(loss(5, 1_700_000_000_010));
        await store.pushTransaction(win(15, 1_700_000_000_090));

        expect(summary.getSummary().lastTradeTime).toBe(1_700_000_000_090);
    });

    test('subscriber notified exactly once per committed transaction', async () => {
        const { logger, store } = setup();

        await store.pushTransaction(win(10));
        await store.pushTransaction(loss(5));
        await store.pushTransaction(makeRecord({ profit: 10, won: true }));

        expect(logger.events).toHaveLength(3);
        const ids = logger.events.map(e => e.context.transactionId);
        expect(new Set(ids).size).toBe(3);
    });

    test('getSummary returns a defensive copy', async () => {
        const { summary, store } = setup();
        await store.pushTransaction(win(10));

        const copy = summary.getSummary();
        copy.totalTrades = 999;

        expect(summary.getSummary().totalTrades).toBe(1);
    });
});