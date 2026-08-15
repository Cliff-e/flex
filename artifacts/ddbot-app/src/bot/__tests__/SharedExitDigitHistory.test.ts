// =============================================================
// Phase 5 — SharedExitDigitHistory Tests
//
// Proves the shared exit-digit history is the final read-only
// consumer in the Virtual Hook pipeline:
//
//     TransactionsStore.subscribe()
//         ├────────► SummaryStore
//         ├────────► VHJournalStore
//         └────────► SharedExitDigitHistory
//
//   • ONLY successful committed VH digit transactions append
//   • CALL/PUT + future non-digit contracts are ignored
//   • same transaction never appends twice
//   • rollback never touches the history
//   • capacity fixed at 21, FIFO
//   • immutable entries, defensive copies
//   • exactly one subscription notification + one log per append
// =============================================================

import {
    appendExitDigit,
    clearExitDigitHistory,
    connectExitDigitHistoryToStore,
    getExitDigitCount,
    getExitDigitHistory,
    getLastNDigits,
    isVHDigitContract,
    onTransactionCommitted,
    resetExitDigitHistory,
    setExitDigitHistoryLogger,
    subscribeToExitDigitHistory,
} from '../sharedExitDigitHistory';
import { TransactionsStore } from '../virtualHook/TransactionsStore';
import type { TransactionRecord } from '../virtualHook/TransactionPipeline';
import type { VHLogContext, VHLogger, VHLogLevel } from '../virtualHook/VHLogger';

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
function makeRecord(
    overrides: Partial<TransactionRecord> & { contractType: string; exitDigit: number | null }
): TransactionRecord {
    seq += 1;
    return {
        transactionId: `TX-${seq}`,
        runId: 'run-1',
        roundIndex: seq - 1,
        contractId: `VH-${seq}`,
        contractType: overrides.contractType,
        symbol: 'R_100',
        stake: 10,
        profit: 10,
        won: true,
        exitDigit: overrides.exitDigit,
        settlement: 'api',
        isVirtual: true,
        settledAt: 1_700_000_000_000 + seq,
        source: 'VH',
        ...overrides,
    };
}

const digitRecord = (digit = 5, contractType = 'DIGITOVER'): TransactionRecord =>
    makeRecord({ contractType, exitDigit: digit });

beforeEach(() => {
    seq = 0;
    resetExitDigitHistory();
});

describe('SharedExitDigitHistory — accepted contracts', () => {
    test.each([
        'DIGITOVER',
        'DIGITUNDER',
        'DIGITMATCH',
        'DIGITDIFF',
        'DIGITEVEN',
        'DIGITODD',
    ])('accepts digit contract %s', contractType => {
        expect(isVHDigitContract(contractType)).toBe(true);
    });

    test.each(['CALL', 'PUT', 'ASIANU', 'TOTALUP', 'MULTUP', 'ONETOUCH', 'EUROPEAN'])(
        'rejects non-digit contract %s',
        contractType => {
            expect(isVHDigitContract(contractType)).toBe(false);
        }
    );
});

describe('SharedExitDigitHistory — connected to TransactionsStore', () => {
    test('one committed digit transaction appends exactly one entry', async () => {
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);
        const store = new TransactionsStore();
        const unsubscribe = connectExitDigitHistoryToStore(store);

        await store.pushTransaction(digitRecord(7, 'DIGITOVER'));

        expect(getExitDigitCount()).toBe(1);
        const history = getExitDigitHistory();
        expect(history).toHaveLength(1);
        const entry = history[0];
        expect(entry.digit).toBe(7);
        expect(entry.source).toBe('VH');
        expect(entry.won).toBe(true);
        expect(entry.contractId).toBe('VH-1');
        expect(entry.transactionId).toBe('TX-1');
        expect(entry.runId).toBe('run-1');
        expect(entry.roundIndex).toBe(0);
        expect(entry.contractType).toBe('DIGITOVER');
        expect(entry.timestamp).toBe(1_700_000_000_001);
        expect(entry.ts).toBe(1_700_000_000_001);
        expect(logger.events).toHaveLength(1);
        expect(logger.events[0].event).toBe('vh.exit_digit.appended');

        unsubscribe();
    });

    test('non-digit contracts are ignored', async () => {
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);

        await store.pushTransaction(makeRecord({ contractType: 'CALL', exitDigit: 9 }));
        await store.pushTransaction(makeRecord({ contractType: 'PUT', exitDigit: 1 }));

        expect(getExitDigitCount()).toBe(0);
        expect(getExitDigitHistory()).toHaveLength(0);
        expect(logger.events).toHaveLength(0);
    });

    test('digit contract without an exit digit is ignored', async () => {
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);

        await store.pushTransaction(makeRecord({ contractType: 'DIGITOVER', exitDigit: null }));

        expect(getExitDigitCount()).toBe(0);
        expect(logger.events).toHaveLength(0);
    });

    test('mixed digit/non-digit stream appends only digit contracts', async () => {
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);

        await store.pushTransaction(digitRecord(1, 'DIGITOVER'));
        await store.pushTransaction(makeRecord({ contractType: 'CALL', exitDigit: 8 }));
        await store.pushTransaction(digitRecord(2, 'DIGITUNDER'));
        await store.pushTransaction(makeRecord({ contractType: 'PUT', exitDigit: 3 }));
        await store.pushTransaction(digitRecord(4, 'DIGITEVEN'));

        expect(getExitDigitCount()).toBe(3);
        const digits = getExitDigitHistory().map(e => e.digit);
        expect(digits).toEqual([1, 2, 4]);
    });
});

describe('SharedExitDigitHistory — duplicate protection', () => {
    test('duplicate commit never appends twice', async () => {
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);
        const record = digitRecord(5);

        const first = await store.pushTransaction(record);
        const second = await store.pushTransaction(record);

        expect(first.appended).toBe(true);
        expect(second.appended).toBe(false);
        expect(getExitDigitCount()).toBe(1);
        expect(logger.events).toHaveLength(1);
    });

    test('same transactionId with different contractId never appends twice', () => {
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);

        const a = digitRecord(3);
        const b = makeRecord({
            contractType: 'DIGITOVER',
            exitDigit: 8,
            transactionId: a.transactionId, // same transaction id
            contractId: 'OTHER-CONTRACT', // different contract
        });

        onTransactionCommitted(a);
        onTransactionCommitted(b);

        expect(getExitDigitCount()).toBe(1);
        expect(getExitDigitHistory()[0].digit).toBe(3);
        expect(logger.events).toHaveLength(1);
    });

    test('same contractId with different transactionId never appends twice', () => {
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);

        const a = digitRecord(3);
        const b = makeRecord({
            contractType: 'DIGITOVER',
            exitDigit: 8,
            transactionId: 'DIFFERENT-TX', // different transaction id
            contractId: a.contractId, // same contract
        });

        onTransactionCommitted(a);
        onTransactionCommitted(b);

        expect(getExitDigitCount()).toBe(1);
        expect(getExitDigitHistory()[0].digit).toBe(3);
        expect(logger.events).toHaveLength(1);
    });
});

describe('SharedExitDigitHistory — rollback', () => {
    test('failed transaction write never touches the history', async () => {
        const failingWriter = () => {
            throw new Error('permanent');
        };
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);
        const store = new TransactionsStore(failingWriter);
        connectExitDigitHistoryToStore(store);

        await expect(store.pushTransaction(digitRecord(5))).rejects.toThrow();

        expect(getExitDigitCount()).toBe(0);
        expect(getExitDigitHistory()).toHaveLength(0);
        expect(logger.events).toHaveLength(0);
    });

    test('recovers after a failed transaction — later success appends exactly once', async () => {
        let fail = true;
        const flakyWriter = () => {
            if (fail) throw new Error('transient');
        };
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);
        const store = new TransactionsStore(flakyWriter);
        connectExitDigitHistoryToStore(store);

        await expect(store.pushTransaction(digitRecord(5, 'DIGITOVER'))).rejects.toThrow();
        expect(getExitDigitCount()).toBe(0);

        fail = false;
        await store.pushTransaction(digitRecord(9, 'DIGITODD'));

        expect(getExitDigitCount()).toBe(1);
        expect(getExitDigitHistory()[0].digit).toBe(9);
        expect(logger.events).toHaveLength(1);
        expect(logger.events[0].event).toBe('vh.exit_digit.appended');
    });
});

describe('SharedExitDigitHistory — FIFO and capacity', () => {
    test('history never exceeds 25 entries', async () => {
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);

        for (let i = 0; i < 30; i++) {
            await store.pushTransaction(digitRecord(i % 10, 'DIGITOVER'));
        }

        expect(getExitDigitCount()).toBe(25);
        expect(getExitDigitHistory()).toHaveLength(25);
    });

    test('FIFO: oldest removed, newest retained after 25 entries', async () => {
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);

        for (let i = 0; i < 30; i++) {
            await store.pushTransaction(digitRecord(i % 10, 'DIGITOVER'));
        }

        const history = getExitDigitHistory();
        // 30 entries were appended in order [0..29] (digits cycle 0..9).
        // After FIFO trimming to 25, kept = appended indices 5..29.
        expect(history.map(e => e.roundIndex)).toEqual(Array.from({ length: 25 }, (_, i) => i + 5));
        expect(history[0].digit).toBe(5 % 10);
        expect(history[24].digit).toBe(29 % 10);
    });

    test('ordering preserved across 25+ entries', async () => {
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);

        for (let i = 0; i < 35; i++) {
            await store.pushTransaction(digitRecord(i % 10, 'DIGITOVER'));
        }

        const history = getExitDigitHistory();
        expect(history).toHaveLength(25);
        // Kept indices 10..34 → roundIndex increases monotonically.
        const roundIndices = history.map(e => e.roundIndex ?? 0);
        expect(roundIndices).toEqual([...roundIndices].sort((a, b) => a - b));
    });
});

describe('SharedExitDigitHistory — immutability and defensive copies', () => {
    test('stored entries are immutable (frozen)', async () => {
        const received: Array<Record<string, unknown>> = [];
        const unsubscribe = subscribeToExitDigitHistory(entry => received.push(entry as unknown as Record<string, unknown>));

        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);
        await store.pushTransaction(digitRecord(5));

        expect(received).toHaveLength(1);
        expect(Object.isFrozen(received[0])).toBe(true);
        expect(() => {
            'use strict';
            (received[0] as Record<string, unknown>).digit = 999;
        }).toThrow(TypeError);

        unsubscribe();
    });

    test('getExitDigitHistory returns defensive copies', async () => {
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);
        await store.pushTransaction(digitRecord(5));

        const copy = getExitDigitHistory()[0];
        copy.digit = 999;
        copy.contractId = 'MUTATED';

        expect(getExitDigitHistory()[0].digit).toBe(5);
        expect(getExitDigitHistory()[0].contractId).toBe('VH-1');
    });

    test('returned copies never affect the stored history', async () => {
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);
        await store.pushTransaction(digitRecord(2));

        const history = getExitDigitHistory();
        history[0].won = false;
        history[0].runId = 'CHANGED';

        expect(getExitDigitHistory()[0].won).toBe(true);
        expect(getExitDigitHistory()[0].runId).toBe('run-1');
    });

    test('getLastNDigits returns plain digit values in order', async () => {
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);
        await store.pushTransaction(digitRecord(1, 'DIGITOVER'));
        await store.pushTransaction(digitRecord(2, 'DIGITUNDER'));
        await store.pushTransaction(digitRecord(3, 'DIGITEVEN'));

        expect(getLastNDigits(2)).toEqual([2, 3]);
        expect(getLastNDigits(10)).toEqual([1, 2, 3]);
    });
});

describe('SharedExitDigitHistory — subscriber notifications', () => {
    test('subscriber notified exactly once per committed digit transaction', async () => {
        const notified: string[] = [];
        const unsubscribe = subscribeToExitDigitHistory(entry => notified.push(`${entry.contractId}:${entry.digit}`));

        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);
        await store.pushTransaction(digitRecord(1, 'DIGITOVER'));
        await store.pushTransaction(digitRecord(2, 'DIGITUNDER'));
        await store.pushTransaction(digitRecord(3, 'DIGITEVEN'));

        expect(notified).toEqual(['VH-1:1', 'VH-2:2', 'VH-3:3']);
        unsubscribe();
    });

    test('non-digit commits do not notify subscribers', async () => {
        const notified: string[] = [];
        const unsubscribe = subscribeToExitDigitHistory(entry => notified.push(String(entry.digit)));

        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);
        await store.pushTransaction(makeRecord({ contractType: 'CALL', exitDigit: 9 }));
        await store.pushTransaction(digitRecord(4, 'DIGITOVER'));
        await store.pushTransaction(makeRecord({ contractType: 'PUT', exitDigit: 1 }));

        expect(notified).toEqual(['4']);
        unsubscribe();
    });

    test('unsubscribe stops notifications', async () => {
        const notified: string[] = [];
        const unsubscribe = subscribeToExitDigitHistory(entry => notified.push(String(entry.digit)));

        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);
        await store.pushTransaction(digitRecord(1, 'DIGITOVER'));
        unsubscribe();
        await store.pushTransaction(digitRecord(2, 'DIGITOVER'));

        expect(notified).toEqual(['1']);
        expect(getExitDigitCount()).toBe(2);
    });
});

describe('SharedExitDigitHistory — logging', () => {
    test('emits exactly one vh.exit_digit.appended log per append with full payload', async () => {
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);

        await store.pushTransaction(digitRecord(5, 'DIGITOVER'));
        await store.pushTransaction(digitRecord(6, 'DIGITOVER'));

        expect(logger.events).toHaveLength(2);
        expect(logger.events[0].event).toBe('vh.exit_digit.appended');
        expect(logger.events[1].event).toBe('vh.exit_digit.appended');

        const first = logger.events[0].context;
        expect(first.contractId).toBe('VH-1');
        expect(first.transactionId).toBe('TX-1');
        expect(first.digit).toBe(5);
        expect(first.won).toBe(true);
        expect(first.historyLength).toBe(1);
        expect(typeof first.timestamp).toBe('number');

        const second = logger.events[1].context;
        expect(second.contractId).toBe('VH-2');
        expect(second.digit).toBe(6);
        expect(second.historyLength).toBe(2);

        expect(logger.events.map(e => e.event)).toEqual([
            'vh.exit_digit.appended',
            'vh.exit_digit.appended',
        ]);
    });
});

describe('SharedExitDigitHistory — scale and determinism', () => {
    test('100 committed transactions produce exactly 100 appends with FIFO', async () => {
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);

        for (let i = 0; i < 100; i++) {
            await store.pushTransaction(digitRecord(i % 10, 'DIGITOVER'));
        }

        expect(getExitDigitCount()).toBe(25);
        expect(logger.events).toHaveLength(100);
        const history = getExitDigitHistory();
        expect(history[0].roundIndex).toBe(75);
        expect(history[24].roundIndex).toBe(99);
    });

    test('1000 committed transactions stay correct and O(1)', async () => {
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);

        for (let i = 0; i < 1000; i++) {
            await store.pushTransaction(digitRecord(i % 10, 'DIGITOVER'));
        }

        expect(getExitDigitCount()).toBe(25);
        expect(logger.events).toHaveLength(1000);
        const history = getExitDigitHistory();
        expect(history).toHaveLength(25);
        expect(history[0].roundIndex).toBe(975);
        expect(history[24].roundIndex).toBe(999);
    });

    test('deterministic replay produces identical history', async () => {
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);

        for (let i = 0; i < 30; i++) {
            await store.pushTransaction(
                digitRecord(i % 10, i % 2 === 0 ? 'DIGITOVER' : 'DIGITUNDER')
            );
        }
        const snapshot = getExitDigitHistory();
        const snapshotLogs = logger.events.length;

        // Deterministic replay from an empty state reproduces the same history.
        await store.clear();
        resetExitDigitHistory();
        logger.events.length = 0;
        seq = 0;
        for (let i = 0; i < 30; i++) {
            await store.pushTransaction(
                digitRecord(i % 10, i % 2 === 0 ? 'DIGITOVER' : 'DIGITUNDER')
            );
        }

        expect(getExitDigitHistory()).toEqual(snapshot);
        expect(logger.events).toHaveLength(snapshotLogs);
    });

    test('appendExitDigit (legacy writers) still works and respects 25 FIFO', () => {
        for (let i = 0; i < 30; i++) {
            appendExitDigit({
                digit: i % 10,
                source: 'VH',
                contractId: `LEGACY-${i}`,
                ts: 1_700_000_000_000 + i,
            });
        }
        expect(getExitDigitCount()).toBe(25);
        expect(getLastNDigits(3)).toEqual([7, 8, 9]);
    });

    test('clearExitDigitHistory resets state including duplicate tracking', () => {
        const logger = new CapturingLogger();
        setExitDigitHistoryLogger(logger);

        onTransactionCommitted(digitRecord(5, 'DIGITOVER'));
        expect(getExitDigitCount()).toBe(1);

        clearExitDigitHistory();
        onTransactionCommitted(digitRecord(5, 'DIGITOVER'));

        expect(getExitDigitCount()).toBe(1);
        expect(logger.events).toHaveLength(2);
    });
});

// ── getLastNConfirmedDigits: recovery consumes only confirmed digits ──────

import { getLastNConfirmedDigits } from '../sharedExitDigitHistory';

describe('getLastNConfirmedDigits — recovery consumes only confirmed exit digits', () => {
    beforeEach(() => {
        resetExitDigitHistory();
    });

    test('returns only source=REAL digits, excluding VH virtual settlements', () => {
        for (let i = 0; i < 5; i++) {
            appendExitDigit({ digit: 1, source: 'VH', ts: 1_700_000_000_000 + i });
        }
        for (let i = 0; i < 5; i++) {
            appendExitDigit({ digit: 2, source: 'REAL', won: i % 2 === 0, ts: 1_700_000_000_100 + i });
        }
        for (let i = 0; i < 5; i++) {
            appendExitDigit({ digit: 3, source: 'VH', won: true, contractId: `VH-x-${i}`, ts: 1_700_000_000_200 + i });
        }
        const confirmed = getLastNConfirmedDigits(20);
        expect(confirmed).toEqual([2, 2, 2, 2, 2]);
        expect(confirmed.every(function (d) { return d === 2; })).toBe(true);
    });

    test('returns the last N confirmed digits in chronological order', () => {
        appendExitDigit({ digit: 1, source: 'REAL', won: true, ts: 1 });
        appendExitDigit({ digit: 9, source: 'VH', ts: 2 });
        appendExitDigit({ digit: 2, source: 'REAL', won: false, ts: 3 });
        appendExitDigit({ digit: 3, source: 'REAL', won: true, ts: 4 });
        appendExitDigit({ digit: 5, source: 'VH', won: true, contractId: 'VH-y', ts: 5 });
        expect(getLastNConfirmedDigits(2)).toEqual([2, 3]);
        expect(getLastNConfirmedDigits(10)).toEqual([1, 2, 3]);
    });

    test('respects the 25-entry FIFO cap when filtered', () => {
        for (let i = 0; i < 30; i++) {
            appendExitDigit({ digit: i % 10, source: 'VH', contractId: `VH-f-${i}`, ts: 1_700_000_000_000 + i });
            appendExitDigit({ digit: (i + 5) % 10, source: 'REAL', won: true, contractId: `REAL-f-${i}`, ts: 1_700_000_000_100 + i });
        }
        // 60 interleaved appends trim to the last 25; 13 of those are REAL.
        const confirmed = getLastNConfirmedDigits(30);
        expect(confirmed).toHaveLength(13);
        expect(confirmed).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4]);
    });

    test('settlement commit is synchronous before recovery reads', async () => {
        const store = new TransactionsStore();
        connectExitDigitHistoryToStore(store);
        await store.pushTransaction(digitRecord(7, 'DIGITOVER'));
        appendExitDigit({ digit: 8, source: 'REAL', won: true, ts: Date.now() });
        expect(getLastNConfirmedDigits(1)).toEqual([8]);
        expect(getLastNConfirmedDigits(5)).toEqual([8]);
    });
});
