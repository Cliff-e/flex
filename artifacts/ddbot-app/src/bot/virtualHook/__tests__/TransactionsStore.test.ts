// =============================================================
// Phase 2 — TransactionsStore + VHTransactionPipeline Tests
// Required: success, duplicate, retry, rollback
// =============================================================

import { TransactionsStore, TransactionWriteError } from '../TransactionsStore';
import { VHTransactionPipeline } from '../TransactionPipeline';
import { VirtualContractFactory } from '../VirtualContract';
import type { TradeCandidate } from '../TradeCandidate';

function makeCandidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
    return {
        signalId: 'test-signal-1',
        source: 'xml',
        contractType: 'DIGITOVER',
        symbol: 'R_100',
        realStake: 10,
        duration: 1,
        durationUnit: 't',
        currency: 'USD',
        basis: 'stake',
        prediction: 5,
        tradeParams: {},
        generatedAt: Date.now(),
        ...overrides,
    };
}

function makeSettledContract(contractId = 'VH-test-1') {
    const candidate = makeCandidate();
    let contract = VirtualContractFactory.create('run-1', 0, candidate, 'proposal-1', 0.5, 1);
    // Deterministic id for assertions — the factory generates a random UUID.
    contract = { ...contract, contractId };
    contract = VirtualContractFactory.recordEntry(contract, 12345.6);
    contract = VirtualContractFactory.settle(
        contract,
        { won: true, source: 'api', rawContract: null, settledAt: 1_700_000_000_000 },
        12345.8
    );
    return contract;
}

// ── 1. Successful write ──────────────────
describe('TransactionsStore — successful write', () => {
    test('one settled contract produces exactly one transaction', async () => {
        const store = new TransactionsStore();
        const pipeline = new VHTransactionPipeline(store);

        const result = await pipeline.process(makeSettledContract('VH-success-1'));

        expect(result.appended).toBe(true);
        expect(result.warnings).toEqual([]);
        expect(result.transaction.contractId).toBe('VH-success-1');
        expect(result.transaction.isVirtual).toBe(true);
        expect(result.transaction.source).toBe('vh_virtual');
        expect(result.transaction.won).toBe(true);
        expect(result.transaction.exitDigit).toBe(8);
        expect(result.transaction.stake).toBe(1);

        expect(store.count).toBe(1);
        expect(store.getByContractId('VH-success-1')).not.toBeNull();
    });
});

// ── 2. Duplicate prevention ──────────────
describe('TransactionsStore — duplicate prevention', () => {
    test('re-processing the same contract does not append a second record', async () => {
        const store = new TransactionsStore();
        const pipeline = new VHTransactionPipeline(store);

        const contract = makeSettledContract('VH-dup-1');

        const first = await pipeline.process(contract);
        const second = await pipeline.process(contract);

        expect(first.appended).toBe(true);
        expect(second.appended).toBe(false);
        expect(store.count).toBe(1);
        expect(second.transaction.contractId).toBe('VH-dup-1');
        expect(second.warnings.some(w => w.includes('Duplicate'))).toBe(true);
    });

    test('a different contract appends independently', async () => {
        const store = new TransactionsStore();
        const pipeline = new VHTransactionPipeline(store);

        await pipeline.process(makeSettledContract('VH-a'));
        await pipeline.process(makeSettledContract('VH-b'));

        expect(store.count).toBe(2);
    });
});

// ── 3. Retry after failure ───────────────
describe('TransactionsStore — retry after failure', () => {
    test('a single transient failure is retried and succeeds', async () => {
        let calls = 0;
        const writer = () => {
            calls++;
            if (calls === 1) throw new Error('transient');
        };

        const store = new TransactionsStore(writer);
        const result = await store.pushTransaction({
            transactionId: 'TX-VH-retry-1',
            runId: 'run-1',
            roundIndex: 0,
            contractId: 'VH-retry-1',
            contractType: 'DIGITOVER',
            symbol: 'R_100',
            stake: 1,
            profit: 1,
            won: true,
            exitDigit: 7,
            settlement: 'api',
            isVirtual: true,
            settledAt: 1_700_000_000_000,
            source: 'vh_virtual',
        });

        expect(calls).toBe(2); // exactly one retry
        expect(result.appended).toBe(true);
        expect(store.count).toBe(1);
        expect(store.getByContractId('VH-retry-1')).not.toBeNull();
    });
});

// ── 4. Rollback on fatal failure ─────────
describe('TransactionsStore — rollback on fatal failure', () => {
    test('a persistent failure rolls back and throws TransactionWriteError', async () => {
        let calls = 0;
        const writer = () => {
            calls++;
            throw new Error('permanent');
        };

        const store = new TransactionsStore(writer);
        await expect(
            store.pushTransaction({
                transactionId: 'TX-VH-fatal-1',
                runId: 'run-1',
                roundIndex: 0,
                contractId: 'VH-fatal-1',
                contractType: 'DIGITOVER',
                symbol: 'R_100',
                stake: 1,
                profit: -1,
                won: false,
                exitDigit: 3,
                settlement: 'api',
                isVirtual: true,
                settledAt: 1_700_000_000_000,
                source: 'vh_virtual',
            })
        ).rejects.toBeInstanceOf(TransactionWriteError);

        expect(calls).toBe(2); // attempt + single retry
        expect(store.count).toBe(0);
        expect(store.getByContractId('VH-fatal-1')).toBeNull();
    });

    test('after a fatal failure, future writes for other contracts still work', async () => {
        let fail = true;
        const writer = (record: { contractId: string }) => {
            if (fail) throw new Error('permanent');
            void record;
        };

        const store = new TransactionsStore(writer);
        await expect(
            store.pushTransaction({
                transactionId: 'TX-VH-fatal-2',
                runId: 'run-1',
                roundIndex: 0,
                contractId: 'VH-fatal-2',
                contractType: 'DIGITOVER',
                symbol: 'R_100',
                stake: 1,
                profit: -1,
                won: false,
                exitDigit: 3,
                settlement: 'api',
                isVirtual: true,
                settledAt: 1_700_000_000_000,
                source: 'vh_virtual',
            })
        ).rejects.toBeInstanceOf(TransactionWriteError);

        fail = false;
        const ok = await store.pushTransaction({
            transactionId: 'TX-VH-ok-2',
            runId: 'run-1',
            roundIndex: 1,
            contractId: 'VH-ok-2',
            contractType: 'DIGITOVER',
            symbol: 'R_100',
            stake: 1,
            profit: 1,
            won: true,
            exitDigit: 9,
            settlement: 'api',
            isVirtual: true,
            settledAt: 1_700_000_000_000,
            source: 'vh_virtual',
        });

        expect(ok.appended).toBe(true);
        expect(store.count).toBe(1);
        expect(store.getByContractId('VH-ok-2')).not.toBeNull();
    });
});
