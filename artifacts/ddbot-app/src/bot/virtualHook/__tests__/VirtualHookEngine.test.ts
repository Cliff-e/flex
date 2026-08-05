// =============================================================
// VirtualHookEngine Tests — Phase 1 integration
//
// Proves: a complete virtual lifecycle executes entirely in
// isolation with NO buy() calls, NO integration with XML/AI.
// =============================================================

import { VirtualHookEngine } from '../VirtualHookEngine';
import { VHDecision } from '../VHDecision';
import type { TradeCandidate } from '../TradeCandidate';
import type { ProposalAdapter, ProposalResult, VHProposal } from '../ProposalAdapter';
import type { TickObserver, VHTick } from '../TickObserver';
import type { TransactionPipeline, TransactionResult } from '../TransactionPipeline';
import type { VHLogger, VHLogContext } from '../VHLogger';

/**
 * Test proposal adapter that returns a fixed proposal.
 */
class FakeProposalAdapter implements ProposalAdapter {
    calls = 0;
    failNextN = 0;

    constructor() {}

    async requestProposal(
        _candidate: TradeCandidate,
        _virtualStake: number,
        _timeoutMs: number
    ): Promise<ProposalResult> {
        this.calls++;
        if (this.failNextN > 0) {
            this.failNextN--;
            return { ok: false, retryable: true, reason: 'transient-failure' };
        }
        const proposal: VHProposal = {
            id: `proposal-${this.calls}`,
            askPrice: 0.5,
            contractType: _candidate.contractType,
            symbol: _candidate.symbol,
        };
        return { ok: true, proposal };
    }

    abort(): void {
        // no-op for tests
    }
}

/**
 * Test tick observer that emits a configurable sequence of ticks.
 */
class FakeTickObserver implements TickObserver {
    private active = false;
    private onTickCallback: ((tick: VHTick) => void) | null = null;
    tickSequence: VHTick[] = [];
    private tickIndex = 0;

    constructor(sequence: number[], private readonly tickDelayMs = 50) {
        this.tickSequence = sequence.map((quote, i) => ({
            quote,
            epoch: 1_700_000_000 + i,
            digit: Number(String(quote).replace('.', '').slice(-1)),
        }));
    }

    async start(_symbol: string, onTick: (tick: VHTick) => void): Promise<void> {
        this.active = true;
        this.onTickCallback = onTick;
        // Reset the index each start so repeated rounds reuse the sequence.
        this.tickIndex = 0;

        // Emit ticks on a timer so the engine can observe the sequence.
        const emitNext = () => {
            if (!this.active) return;
            if (this.tickIndex >= this.tickSequence.length) return;
            const tick = this.tickSequence[this.tickIndex++];
            this.onTickCallback?.(tick);
            setTimeout(emitNext, this.tickDelayMs);
        };
        setTimeout(emitNext, this.tickDelayMs);
    }

    async stop(): Promise<void> {
        this.active = false;
        this.onTickCallback = null;
    }

    isActive(): boolean {
        return this.active;
    }
}

/**
 * Test transaction pipeline that captures processed contracts.
 */
class FakeTransactionPipeline implements TransactionPipeline {
    processed: unknown[] = [];

    async process(contract: never): Promise<TransactionResult> {
        this.processed.push(contract);
        return {
            transaction: {
                transactionId: 'tx-test',
                runId: 'run-test',
                contractId: 'contract-test',
                contractType: 'DIGITOVER',
                symbol: 'R_100',
                stake: 1,
                won: true,
                exitDigit: 5,
                isVirtual: true,
                settledAt: Date.now(),
                source: 'vh_virtual',
            },
            appended: true,
            exitDigitRecorded: true,
            warnings: [],
        };
    }
}

/**
 * Test logger that captures entries for assertions.
 */
class TestLogger implements VHLogger {
    entries: { level: string; event: string; context: VHLogContext }[] = [];

    info(event: string, context: VHLogContext): void {
        this.entries.push({ level: 'info', event, context });
    }
    warn(event: string, context: VHLogContext): void {
        this.entries.push({ level: 'warn', event, context });
    }
    error(event: string, context: VHLogContext): void {
        this.entries.push({ level: 'error', event, context });
    }
    debug(event: string, context: VHLogContext): void {
        this.entries.push({ level: 'debug', event, context });
    }
}

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

describe('VirtualHookEngine', () => {
    test('AUTHORIZED when enough wins observed', async () => {
        // Sequence: digits [6, 7, 8] — all win DIGITOVER > 5.
        const adapter = new FakeProposalAdapter();
        const ticks = new FakeTickObserver([1006, 1007, 1008]);
        const pipeline = new FakeTransactionPipeline();
        const logger = new TestLogger();

        const engine = new VirtualHookEngine(adapter, ticks, pipeline, logger, {
            maxSteps: 3,
            minWins: 2,
            virtualStake: 1,
            enabled: true,
            settlementTimeoutMs: 5_000,
        });

        const result = await engine.start(makeCandidate());

        expect(result.decision).toBe(VHDecision.AUTHORIZED);
        expect(result.wins).toBeGreaterThanOrEqual(2);
        expect(adapter.calls).toBeGreaterThanOrEqual(2);
        // The pipeline must have processed at least the winning rounds.
        expect(pipeline.processed.length).toBeGreaterThanOrEqual(2);

        // Structured logging must contain state transitions.
        const transitions = logger.entries.filter(e => e.event === 'vh.state_transition');
        expect(transitions.length).toBeGreaterThan(0);
        // Terminal transitions must log state context.
        expect(transitions[0].context.currentState).toBeDefined();
    }, 15_000);

    test('REJECTED when max steps exhausted without enough wins', async () => {
        // Sequence: digits [4, 3, 2] — all LOSERS for DIGITOVER > 5.
        const adapter = new FakeProposalAdapter();
        const ticks = new FakeTickObserver([1004, 1003, 1002]);
        const pipeline = new FakeTransactionPipeline();
        const logger = new TestLogger();

        const engine = new VirtualHookEngine(adapter, ticks, pipeline, logger, {
            maxSteps: 3,
            minWins: 2,
            virtualStake: 1,
            enabled: true,
            settlementTimeoutMs: 5_000,
        });

        const result = await engine.start(makeCandidate());

        expect(result.decision).toBe(VHDecision.REJECTED);
        expect(result.roundsCompleted).toBe(3);
    }, 15_000);

    test('STOPPED with invalid TradeCandidate', async () => {
        const adapter = new FakeProposalAdapter();
        const ticks = new FakeTickObserver([1001]);
        const logger = new TestLogger();

        const engine = new VirtualHookEngine(adapter, ticks, undefined, logger, {
            maxSteps: 3,
            minWins: 2,
            enabled: true,
        });

        const bad = {
            signalId: 'test',
            source: 'xml',
            // missing contractType, symbol, etc.
        } as unknown as TradeCandidate;

        const result = await engine.start(bad);

        expect(result.decision).toBe(VHDecision.STOPPED);
        expect(adapter.calls).toBe(0);
    }, 15_000);

    test('Proposal retries eventually succeed', async () => {
        const adapter = new FakeProposalAdapter();
        adapter.failNextN = 2;
        const ticks = new FakeTickObserver([1006, 1007]); // both win > 5
        const logger = new TestLogger();

        const engine = new VirtualHookEngine(adapter, ticks, new FakeTransactionPipeline(), logger, {
            maxSteps: 2,
            minWins: 2,
            virtualStake: 1,
            enabled: true,
            maxProposalRetries: 5,
            settlementTimeoutMs: 5_000,
        });

        const result = await engine.start(makeCandidate());

        expect(result.decision).toBe(VHDecision.AUTHORIZED);
        // 2 successful proposals + 2 failed initial attempts.
        expect(adapter.calls).toBe(4);
    }, 15_000);

    test('Busy engine rejects a second start() call', async () => {
        const adapter = new FakeProposalAdapter();
        const ticks = new FakeTickObserver([1006, 1007, 1008]);
        const engine = new VirtualHookEngine(adapter, ticks, new FakeTransactionPipeline(), new TestLogger(), {
            maxSteps: 2,
            minWins: 2,
            virtualStake: 1,
            enabled: true,
            settlementTimeoutMs: 1_000,
        });

        const first = engine.start(makeCandidate());
        // This should throw VirtualHookBusyError synchronously (async rejection).
        await expect(engine.start(makeCandidate())).rejects.toThrow(/already processing/i);
        await first;
    }, 15_000);

    test('getStatus reflects active run', async () => {
        const adapter = new FakeProposalAdapter();
        const ticks = new FakeTickObserver([1006, 1007]);
        const engine = new VirtualHookEngine(adapter, ticks, new FakeTransactionPipeline(), new TestLogger(), {
            maxSteps: 2,
            minWins: 2,
            virtualStake: 1,
            enabled: true,
        });

        expect(engine.isEnabled()).toBe(true);

        const running = engine.start(makeCandidate());
        const status = engine.getStatus();
        expect(status.active).toBe(true);

        const result = await running;
        expect(result.decision).toBe(VHDecision.AUTHORIZED);

        // After completion, the engine is no longer active.
        const after = engine.getStatus();
        expect(after.active).toBe(false);
    }, 15_000);
});