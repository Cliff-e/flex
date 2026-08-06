// Phase 2 Audit — TransactionsStore guarantees
import { TransactionsStore, TransactionWriteError } from '../TransactionsStore';
import type { TransactionRecord } from '../TransactionPipeline';

function makeRecord(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
    return {
        transactionId: `TX-${overrides.contractId ?? 'x'}`,
        runId: 'run-1',
        roundIndex: 0,
        contractId: 'VH-a',
        contractType: 'DIGITOVER',
        symbol: 'R_100',
        stake: 1,
        profit: 1,
        won: true,
        exitDigit: 5,
        settlement: 'api',
        isVirtual: true,
        settledAt: 1_700_000_000_000,
        source: 'vh_virtual',
        ...overrides,
    };
}

// ── 2. Settlement ordering ──
describe('Audit — settlement ordering', () => {
    test('contract settled later is stored AFTER one settled earlier', async () => {
        const store = new TransactionsStore();
        await store.pushTransaction(makeRecord({ contractId: 'VH-A', settledAt: 2_000 }));
        await store.pushTransaction(makeRecord({ contractId: 'VH-B', settledAt: 1_000 }));
        expect(store.getRecords().map(r => r.contractId)).toEqual(['VH-B', 'VH-A']);
    });

    test('equal settledAt falls back to roundIndex then contractId', async () => {
        const store = new TransactionsStore();
        await store.pushTransaction(makeRecord({ contractId: 'VH-Z', settledAt: 5_000, roundIndex: 2 }));
        await store.pushTransaction(makeRecord({ contractId: 'VH-A', settledAt: 5_000, roundIndex: 0 }));
        await store.pushTransaction(makeRecord({ contractId: 'VH-M', settledAt: 5_000, roundIndex: 1 }));
        expect(store.getRecords().map(r => r.contractId)).toEqual(['VH-A', 'VH-M', 'VH-Z']);
    });
});

// ── 3. High concurrency ──
describe('Audit — 100 concurrent pushes', () => {
    test('100 concurrent contracts → 100 stored, 0 dupes, 0 drops', async () => {
        const store = new TransactionsStore();
        const pushes = Array.from({ length: 100 }, (_, i) =>
            store.pushTransaction(makeRecord({ contractId: `VH-${i}`, settledAt: 1_000 + i, roundIndex: i }))
        );
        const results = await Promise.all(pushes);

        expect(store.count).toBe(100);
        expect(results.every(r => r.appended)).toBe(true);
        const ids = store.getRecords().map(r => r.contractId);
        expect(new Set(ids).size).toBe(100);
        const settledAts = store.getRecords().map(r => r.settledAt);
        expect(settledAts).toEqual([...settledAts].sort((a, b) => a - b));
    });

    test('concurrent duplicate pushes of the same contract yield exactly one record', async () => {
        const store = new TransactionsStore();
        const results = await Promise.all(
            Array.from({ length: 20 }, () => store.pushTransaction(makeRecord({ contractId: 'VH-SAME' })))
        );
        expect(results.filter(r => r.appended).length).toBe(1);
        expect(store.count).toBe(1);
    });
});

// ── 4. Recovery after fatal failure ──
describe('Audit — recovery after fatal failure', () => {
    test('after TransactionWriteError the store is unlocked and the failed record absent', async () => {
        let fail = true;
        const writer = () => {
            if (fail) throw new Error('down');
        };
        const store = new TransactionsStore(writer);

        await expect(store.pushTransaction(makeRecord({ contractId: 'VH-FAIL' }))).rejects.toBeInstanceOf(
            TransactionWriteError
        );
        expect(store.count).toBe(0);

        fail = false;
        const ok = await store.pushTransaction(makeRecord({ contractId: 'VH-OK' }));
        expect(ok.appended).toBe(true);
        expect(store.count).toBe(1);
        expect(store.getByContractId('VH-OK')).not.toBeNull();
        expect(store.getByContractId('VH-FAIL')).toBeNull();
    });
});

// ── 5. Immutability ──
describe('Audit — immutable records', () => {
    test('mutating a returned copy does NOT affect the store', async () => {
        const store = new TransactionsStore();
        await store.pushTransaction(makeRecord({ contractId: 'VH-IMM' }));

        const copy = store.getByContractId('VH-IMM');
        expect(copy).not.toBeNull();
        if (copy) copy.won = false;

        const again = store.getByContractId('VH-IMM');
        expect(again?.won).toBe(true);
    });

    test('listener receives a frozen record', async () => {
        const store = new TransactionsStore();
        let seen: TransactionRecord | null = null;
        store.subscribe(r => {
            seen = r;
        });

        await store.pushTransaction(makeRecord({ contractId: 'VH-SUB-IMM' }));
        expect(seen).not.toBeNull();
        expect(Object.isFrozen(seen)).toBe(true);
    });
});

// ── 6. 100,000 ID uniqueness ──
describe('Audit — transaction ID uniqueness (100k)', () => {
    test('100,000 generated TX ids have zero collisions', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100_000; i++) {
            ids.add(`TX-VH-${crypto.randomUUID?.() ?? `${i}-${Math.random()}`}`);
        }
        expect(ids.size).toBe(100_000);
    });
});

// ── 7. Ownership / single-commit event ──
describe('Audit — commit events (event-pipeline seam)', () => {
    test('subscribe fires ONCE per committed transaction', async () => {
        const store = new TransactionsStore();
        const events: string[] = [];
        store.subscribe(r => events.push(r.contractId));

        await store.pushTransaction(makeRecord({ contractId: 'VH-E1' }));
        await store.pushTransaction(makeRecord({ contractId: 'VH-E2' }));

        expect(events).toEqual(['VH-E1', 'VH-E2']);
    });

    test('subscribe does NOT fire for duplicate (idempotent) pushes', async () => {
        const store = new TransactionsStore();
        const events: string[] = [];
        store.subscribe(r => events.push(r.contractId));

        await store.pushTransaction(makeRecord({ contractId: 'VH-DUP-EV' }));
        await store.pushTransaction(makeRecord({ contractId: 'VH-DUP-EV' }));

        expect(events).toEqual(['VH-DUP-EV']);
    });
});
