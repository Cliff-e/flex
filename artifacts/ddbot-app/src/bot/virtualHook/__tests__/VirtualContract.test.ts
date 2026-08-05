// =============================================================
// VirtualContract Tests
// =============================================================

import { VirtualContractFactory, estimateDurationMs, extractDigitValue } from '../VirtualContract';
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

describe('VirtualContractFactory.create', () => {
    test('Creates a contract with expected defaults', () => {
        const candidate = makeCandidate();
        const contract = VirtualContractFactory.create(
            'run-1',
            0,
            candidate,
            'proposal-id',
            0.5,
            1
        );

        expect(contract.contractId).toMatch(/^VH-/);
        expect(contract.runId).toBe('run-1');
        expect(contract.roundIndex).toBe(0);
        expect(contract.candidate).toBe(candidate);
        expect(contract.proposalId).toBe('proposal-id');
        expect(contract.askPrice).toBe(0.5);
        expect(contract.virtualStake).toBe(1);
        expect(contract.derivContractId).toBeNull();
        expect(contract.entryAt).toBeNull();
        expect(contract.entryTick).toBeNull();
        expect(contract.entryDigit).toBeNull();
        expect(contract.settledAt).toBeNull();
        expect(contract.exitTick).toBeNull();
        expect(contract.exitDigit).toBeNull();
        expect(contract.settlement).toBeNull();
        expect(contract.status).toBe('PROPOSAL_RECEIVED');
        expect(contract.durationMs).toBe(1_000);
        expect(contract.timeoutAt).toBeGreaterThan(contract.createdAt);
    });

    test('Production of unique contract ids', () => {
        const candidate = makeCandidate();
        const c1 = VirtualContractFactory.create('run', 0, candidate, 'p1', 0.5, 1);
        const c2 = VirtualContractFactory.create('run', 1, candidate, 'p2', 0.5, 1);
        expect(c1.contractId).not.toBe(c2.contractId);
    });
});

describe('VirtualContractFactory.markBought', () => {
    test('Marks contract as ACTIVE with deriv id', () => {
        const candidate = makeCandidate();
        const contract = VirtualContractFactory.create('run', 0, candidate, 'p', 0.5, 1);
        const bought = VirtualContractFactory.markBought(contract, 'deriv-123');

        expect(bought.derivContractId).toBe('deriv-123');
        expect(bought.status).toBe('ACTIVE');
    });
});

describe('VirtualContractFactory.recordEntry', () => {
    test('Records entry tick and digit', () => {
        const candidate = makeCandidate();
        const contract = VirtualContractFactory.create('run', 0, candidate, 'p', 0.5, 1);
        const entered = VirtualContractFactory.recordEntry(contract, 12345.6);

        expect(entered.entryTick).toBe(12345.6);
        expect(entered.entryDigit).toBe(6);
        expect(entered.entryAt).not.toBeNull();
        expect(entered.status).toBe('WAITING_SETTLEMENT');
    });
});

describe('VirtualContractFactory.settle', () => {
    test('Settlement with source=api sets status SETTLED', () => {
        const candidate = makeCandidate();
        let contract = VirtualContractFactory.create('run', 0, candidate, 'p', 0.5, 1);
        contract = VirtualContractFactory.recordEntry(contract, 12345.6);
        const settled = VirtualContractFactory.settle(
            contract,
            { won: true, source: 'api', rawContract: null, settledAt: Date.now() },
            12349.9
        );

        expect(settled.status).toBe('SETTLED');
        expect(settled.settlement?.won).toBe(true);
        expect(settled.settlement?.source).toBe('api');
        expect(settled.exitTick).toBe(12349.9);
        expect(settled.exitDigit).toBe(9);
        expect(settled.settledAt).not.toBeNull();
    });

    test('Settlement with source=timeout sets status TIMED_OUT', () => {
        const candidate = makeCandidate();
        let contract = VirtualContractFactory.create('run', 0, candidate, 'p', 0.5, 1);
        contract = VirtualContractFactory.recordEntry(contract, 12345.6);
        const settled = VirtualContractFactory.settle(
            contract,
            { won: false, source: 'timeout', rawContract: null, settledAt: Date.now() },
            null
        );

        expect(settled.status).toBe('TIMED_OUT');
        expect(settled.exitTick).toBeNull();
        expect(settled.exitDigit).toBeNull();
    });

    test('Settlement with source=error sets status ERROR', () => {
        const candidate = makeCandidate();
        let contract = VirtualContractFactory.create('run', 0, candidate, 'p', 0.5, 1);
        contract = VirtualContractFactory.recordEntry(contract, 12345.6);
        const settled = VirtualContractFactory.settle(
            contract,
            { won: false, source: 'error', rawContract: null, settledAt: Date.now() },
            null
        );

        expect(settled.status).toBe('ERROR');
    });
});

describe('estimateDurationMs', () => {
    test('Tick duration = n * 1s', () => {
        expect(estimateDurationMs(5, 't')).toBe(5_000);
    });

    test('Seconds = n * 1s', () => {
        expect(estimateDurationMs(30, 's')).toBe(30_000);
    });

    test('Minutes = n * 60s', () => {
        expect(estimateDurationMs(2, 'm')).toBe(120_000);
    });

    test('Hours = n * 3600s', () => {
        expect(estimateDurationMs(1, 'h')).toBe(3_600_000);
    });

    test('Days = n * 86400s', () => {
        expect(estimateDurationMs(1, 'd')).toBe(86_400_000);
    });

    test('Clamps to minimum of 1', () => {
        expect(estimateDurationMs(0, 't')).toBe(1_000);
    });
});

describe('extractDigitValue', () => {
    test('Extracts last digit from integer string', () => {
        expect(extractDigitValue('1234567')).toBe(7);
    });

    test('Extracts last digit from decimal string', () => {
        expect(extractDigitValue('1234.56')).toBe(6);
    });

    test('Extracts last digit from number', () => {
        expect(extractDigitValue(12345)).toBe(5);
    });
});