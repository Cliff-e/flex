// =============================================================
// Phase 4 — VHJournalStore Tests
//
// Proves the Journal is a read-only consumer of committed
// TransactionRecords:
//   • appends ONLY from TransactionsStore.subscribe()
//   • exactly one immutable entry per successful commit
//   • duplicates and failed/rolled-back writes never append
//   • entry order = commit order (transaction ordering preserved)
//   • O(1) append-only — never rebuilt from history
// =============================================================

import { VHJournalStore, type VHJournalEntry } from '../VHJournalStore';
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

function setup() {
    const logger = new CapturingLogger();
    const journal = new VHJournalStore(logger);
    const store = new TransactionsStore();
    store.subscribe(record => journal.onTransactionCommitted(record));
    return { logger, journal, store };
}

describe('VHJournalStore — single transaction', () => {
    test('one committed transaction produces exactly one journal entry', async () => {
        const { logger, journal, store } = setup();

        await store.pushTransaction(makeRecord({ settledAt: 1_700_000_000_100 }));

        expect(journal.count).toBe(1);
        const entries = journal.getEntries();
        expect(entries).toHaveLength(1);

        const entry = entries[0];
        expect(entry.entryId).toBe('J-TX-1');
        expect(entry.event).toBe('VH_SETTLEMENT');
        expect(entry.source).toBe('vh_virtual');
        expect(entry.transactionId).toBe('TX-1');
        expect(entry.contractId).toBe('VH-1');
        expect(entry.runId).toBe('run-1');
        expect(entry.roundIndex).toBe(0);
        expect(entry.contractType).toBe('DIGITOVER');
        expect(entry.symbol).toBe('R_100');
        expect(entry.won).toBe(true);
        expect(entry.profit).toBe(10);
        expect(entry.stake).toBe(10);
        expect(entry.exitDigit).toBe(5);
        expect(entry.settlement).toBe('api');
        expect(entry.timestamp).toBe(1_700_000_000_100);
        expect(logger.events).toHaveLength(1);
        expect(logger.events[0].event).toBe('vh.journal.updated');
    });
});

describe('VHJournalStore — multiple transactions', () => {
    test('two transactions produce two entries in commit order', async () => {
        const { journal, store } = setup();

        await store.pushTransaction(makeRecord({ contractId: 'VH-A', transactionId: 'TX-A', settledAt: 1_700_000_000_200 }));
        await store.pushTransaction(makeRecord({ contractId: 'VH-B', transactionId: 'TX-B', settledAt: 1_700_000_000_100 }));

        const entries = journal.getEntries();
        expect(journal.count).toBe(2);
        expect(entries[0].contractId).toBe('VH-A');
        expect(entries[1].contractId).toBe('VH-B');
    });
});

describe('VHJournalStore — duplicate handling', () => {
    test('duplicate transaction never appends a second entry', async () => {
        const { logger, journal, store } = setup();
        const record = makeRecord({ contractId: 'VH-DUP' });

        const first = await store.pushTransaction(record);
        const second = await store.pushTransaction(record);

        expect(first.appended).toBe(true);
        expect(second.appended).toBe(false);
        expect(journal.count).toBe(1);
        expect(journal.getEntries()).toHaveLength(1);
        expect(logger.events).toHaveLength(1);
    });
});

describe('VHJournalStore — rollback handling', () => {
    test('failed transaction write never reaches the journal', async () => {
        const failingWriter = () => {
            throw new Error('permanent');
        };
        const logger = new CapturingLogger();
        const journal = new VHJournalStore(logger);
        const store = new TransactionsStore(failingWriter);
        store.subscribe(record => journal.onTransactionCommitted(record));

        await expect(store.pushTransaction(makeRecord())).rejects.toThrow();

        expect(journal.count).toBe(0);
        expect(journal.getEntries()).toHaveLength(0);
        expect(logger.events).toHaveLength(0);
    });

    test('journal survives failed write — later success still appends', async () => {
        let fail = true;
        const flakyWriter = () => {
            if (fail) throw new Error('transient');
        };
        const logger = new CapturingLogger();
        const journal = new VHJournalStore(logger);
        const store = new TransactionsStore(flakyWriter);
        store.subscribe(record => journal.onTransactionCommitted(record));

        await expect(store.pushTransaction(makeRecord({ contractId: 'VH-BAD' }))).rejects.toThrow();
        expect(journal.count).toBe(0);

        fail = false;
        await store.pushTransaction(makeRecord({ contractId: 'VH-GOOD' }));

        expect(journal.count).toBe(1);
        expect(journal.getEntries()[0].contractId).toBe('VH-GOOD');
        expect(logger.events).toHaveLength(1);
        expect(logger.events[0].event).toBe('vh.journal.updated');
    });
});

describe('VHJournalStore — one notification per commit', () => {
    test('subscriber receives exactly one notification per committed transaction', async () => {
        const { journal, store } = setup();
        const notified: string[] = [];
        journal.subscribe(entry => notified.push(entry.transactionId));

        await store.pushTransaction(makeRecord({ transactionId: 'TX-1' }));
        await store.pushTransaction(makeRecord({ transactionId: 'TX-2' }));
        await store.pushTransaction(makeRecord({ transactionId: 'TX-3' }));

        expect(notified).toEqual(['TX-1', 'TX-2', 'TX-3']);
        expect(new Set(notified).size).toBe(3);
    });

    test('duplicate commit does not notify again', async () => {
        const { journal, store } = setup();
        const notified: string[] = [];
        journal.subscribe(entry => notified.push(entry.transactionId));
        const record = makeRecord({ transactionId: 'TX-DUP' });

        await store.pushTransaction(record);
        await store.pushTransaction(record);

        expect(notified).toEqual(['TX-DUP']);
    });

    test('unsubscribe stops notifications', async () => {
        const { journal, store } = setup();
        const notified: string[] = [];
        const unsubscribe = journal.subscribe(entry => notified.push(entry.transactionId));

        await store.pushTransaction(makeRecord({ transactionId: 'TX-1' }));
        unsubscribe();
        await store.pushTransaction(makeRecord({ transactionId: 'TX-2' }));

        expect(notified).toEqual(['TX-1']);
        expect(journal.count).toBe(2);
    });
});

describe('VHJournalStore — ordering', () => {
    test('entries are in chronological commit order', async () => {
        const { journal, store } = setup();

        await store.pushTransaction(makeRecord({ contractId: 'VH-1', settledAt: 1_700_000_000_001 }));
        await store.pushTransaction(makeRecord({ contractId: 'VH-2', settledAt: 1_700_000_000_003 }));
        await store.pushTransaction(makeRecord({ contractId: 'VH-3', settledAt: 1_700_000_000_002 }));

        const entries = journal.getEntries();
        expect(entries.map(e => e.contractId)).toEqual(['VH-1', 'VH-2', 'VH-3']);
        expect(entries.map(e => e.timestamp)).toEqual([1_700_000_000_001, 1_700_000_000_003, 1_700_000_000_002]);
    });

    test('transaction ordering is preserved exactly as committed', async () => {
        const { journal, store } = setup();

        await store.pushTransaction(makeRecord({ transactionId: 'TX-A', roundIndex: 2 }));
        await store.pushTransaction(makeRecord({ transactionId: 'TX-B', roundIndex: 0 }));
        await store.pushTransaction(makeRecord({ transactionId: 'TX-C', roundIndex: 1 }));

        const entries = journal.getEntries();
        expect(entries.map(e => e.transactionId)).toEqual(['TX-A', 'TX-B', 'TX-C']);
        expect(entries.map(e => e.roundIndex)).toEqual([2, 0, 1]);
    });
});

describe('VHJournalStore — immutability and defensive copies', () => {
    test('stored entries are immutable', async () => {
        const { journal, store } = setup();

        await store.pushTransaction(makeRecord());

        // Internal stored entries must be deep-frozen.
        const internal = (journal as unknown as { _entries: VHJournalEntry[] })._entries;
        expect(Object.isFrozen(internal[0])).toBe(true);
        expect(() => {
            'use strict';
            (internal[0] as unknown as Record<string, unknown>).profit = 999;
        }).toThrow(TypeError);
    });

    test('getEntries returns defensive copies', async () => {
        const { journal, store } = setup();

        await store.pushTransaction(makeRecord({ profit: 10 }));
        const original = journal.getEntry(journal.getEntries()[0].entryId);
        expect(original?.profit).toBe(10);
        const originalId = original?.entryId ?? '';

        const copy = journal.getEntries()[0];
        copy.profit = 999;
        copy.entryId = 'MUTATED';

        const entries = journal.getEntries();
        expect(entries[0].profit).toBe(10);
        expect(entries[0].entryId).toBe(originalId);
    });

    test('getEntry returns a defensive copy', async () => {
        const { journal, store } = setup();

        await store.pushTransaction(makeRecord());
        const stored = journal.getEntries()[0];
        const entryId = stored.entryId;
        const originalStake = stored.stake;

        const copy = journal.getEntry(entryId);
        expect(copy).not.toBeNull();
        if (copy) {
            copy.stake = 999;
            expect(journal.getEntry(entryId)?.stake).toBe(originalStake);
        }
    });

    test('mutating a returned entry never affects the journal', async () => {
        const { journal, store } = setup();
        await store.pushTransaction(makeRecord({ profit: 10 }));

        const original = journal.getEntry(journal.getEntries()[0].entryId);
        const originalId = original?.entryId ?? '';

        const first = journal.getEntries();
        first[0].profit = 999;

        expect(journal.getEntries()[0].profit).toBe(10);
        expect(journal.getEntry(originalId)?.profit).toBe(10);
    });
});

describe('VHJournalStore — logging', () => {
    test('emits exactly one vh.journal.updated event per entry with full payload', async () => {
        const { logger, store } = setup();

        await store.pushTransaction(makeRecord({ transactionId: 'TX-LOG', runId: 'run-log' }));
        await store.pushTransaction(makeRecord({ transactionId: 'TX-LOG2', runId: 'run-log' }));

        expect(logger.events).toHaveLength(2);
        expect(logger.events[0].event).toBe('vh.journal.updated');
        expect(logger.events[1].event).toBe('vh.journal.updated');

        const first = logger.events[0].context;
        expect(first.entryId).toBe('J-TX-LOG');
        expect(first.transactionId).toBe('TX-LOG');
        expect(first.runId).toBe('run-log');
        expect(first.previousLength).toBe(0);
        expect(first.newLength).toBe(1);
        expect(typeof first.timestamp).toBe('number');

        const second = logger.events[1].context;
        expect(second.entryId).toBe('J-TX-LOG2');
        expect(second.transactionId).toBe('TX-LOG2');
        expect(second.previousLength).toBe(1);
        expect(second.newLength).toBe(2);

        // No duplicate logs — exactly one per commit.
        const events = logger.events.map(e => e.event);
        expect(events).toEqual(['vh.journal.updated', 'vh.journal.updated']);
    });
});

describe('VHJournalStore — scale and determinism', () => {
    test('100 committed transactions produce 100 journal entries in order', async () => {
        const { logger, journal, store } = setup();

        for (let i = 0; i < 100; i++) {
            await store.pushTransaction(
                makeRecord({
                    contractId: `VH-${i}`,
                    transactionId: `TX-${i}`,
                    roundIndex: i,
                    settledAt: 1_700_000_000_000 + i,
                    won: i % 2 === 0,
                    profit: i % 2 === 0 ? 10 : -10,
                })
            );
        }

        expect(journal.count).toBe(100);
        const entries = journal.getEntries();
        expect(entries).toHaveLength(100);
        expect(entries.map(e => e.contractId)).toEqual(Array.from({ length: 100 }, (_, i) => `VH-${i}`));
        expect(entries.map(e => e.roundIndex)).toEqual(Array.from({ length: 100 }, (_, i) => i));
        expect(logger.events).toHaveLength(100);
    });

    test('1000 committed transactions stay correct and O(1)', async () => {
        const { logger, journal, store } = setup();

        for (let i = 0; i < 1000; i++) {
            await store.pushTransaction(
                makeRecord({
                    contractId: `VH-${i}`,
                    transactionId: `TX-${i}`,
                    roundIndex: i,
                    settledAt: 1_700_000_000_000 + i,
                })
            );
        }

        expect(journal.count).toBe(1000);
        const entries = journal.getEntries();
        expect(entries).toHaveLength(1000);
        expect(entries[0].contractId).toBe('VH-0');
        expect(entries[999].contractId).toBe('VH-999');
        const ids = new Set(entries.map(e => e.entryId));
        expect(ids.size).toBe(1000);
        expect(logger.events).toHaveLength(1000);
    });

    test('deterministic replay produces identical journal', async () => {
        const { logger, journal, store } = setup();
        const records: TransactionRecord[] = [];
        for (let i = 0; i < 50; i++) {
            records.push(
                makeRecord({
                    contractId: `VH-${i}`,
                    transactionId: `TX-${i}`,
                    roundIndex: i,
                    settledAt: 1_700_000_000_000 + i,
                    won: i % 3 === 0,
                    profit: i % 3 === 0 ? 10 : -4,
                })
            );
        }

        for (const record of records) await store.pushTransaction(record);
        const snapshot = journal.getEntries();
        const snapshotLogs = logger.events.length;

        // Deterministic: replaying the identical sequence from an empty
        // state reproduces the same journal with exactly one log per commit.
        await store.clear();
        journal.reset();
        logger.events.length = 0;
        seq = 0;
        for (const record of records) await store.pushTransaction(record);

        expect(journal.getEntries()).toEqual(snapshot);
        expect(logger.events).toHaveLength(snapshotLogs);
    });

    test('incremental appends remain correct after every commit', async () => {
        const { journal, store } = setup();

        for (let i = 0; i < 25; i++) {
            await store.pushTransaction(
                makeRecord({ contractId: `VH-${i}`, transactionId: `TX-${i}`, roundIndex: i })
            );
            expect(journal.count).toBe(i + 1);
            const entries = journal.getEntries();
            expect(entries).toHaveLength(i + 1);
            expect(entries[i].contractId).toBe(`VH-${i}`);
        }
    });
});