// =============================================================
// VirtualHookEngine Lifecycle Tests — Phase 8 production hardening
//
// Proves:
//   • dispose() releases the observer, adapter, and blocks reuse.
//   • Every terminal decision emits vh.run_completed with full context.
//   • configure() preserves previously-set fields (partial merge).
// =============================================================

import { VirtualHookEngine } from '../VirtualHookEngine';
import { VHDecision } from '../VHDecision';
import type { TradeCandidate } from '../TradeCandidate';
import type { ProposalAdapter, ProposalResult, VHProposal } from '../ProposalAdapter';
import type { TickObserver, VHTick } from '../TickObserver';
import type { TransactionPipeline, TransactionResult } from '../TransactionPipeline';
import type { VHLogger, VHLogContext } from '../VHLogger';
import { VirtualHookError } from '../errors';

/**
 * Proposal adapter that can report abort() calls.
 */
class TrackedProposalAdapter implements ProposalAdapter {
    aborted = false;

    async requestProposal(
        _candidate: TradeCandidate,
        _virtualStake: number,
        _timeoutMs: number
    ): Promise<ProposalResult> {
        const proposal: VHProposal = {
            id: 'prop-1',
            askPrice: 0.5,
            contractType: _candidate.contractType,
            symbol: _candidate.symbol,
        };
        return { ok: true, proposal };
    }

    abort(): void {
        this.aborted = true;
    }
}

/**
 * Tick observer that can report stop() calls and emits a configurable
 * tick sequence (default winning sequence).
 */
class TrackedTickObserver implements TickObserver {
    stopped = false;
    active = false;
    private readonly quotes: number[];

    constructor(quotes: number[] = [1006, 1007, 1008]) {
        this.quotes = quotes;
    }

    async start(symbol: string, onTick: (tick: VHTick) => void): Promise<void> {
        this.active = true;
        this.quotes.forEach((quote, i) => {
            setTimeout(() => onTick({ quote, epoch: 1_700_000_000 + i, digit: Number(String(quote).replace('.', '').slice(-1)) }), i * 10);
        });
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.active = false;
    }

    isActive(): boolean {
        return this.active;
    }
}

/**
 * Logger that captures entries for assertions.
 */
class CaptureLogger implements VHLogger {
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

class NoopPipeline implements TransactionPipeline {
    async process(_contract: never): Promise<TransactionResult> {
        return {
            transaction: {
                transactionId: 'tx-1',
                runId: 'run-1',
                roundIndex: 0,
                contractId: 'c-1',
                contractType: 'DIGITOVER',
                symbol: 'R_100',
                stake: 1,
                profit: 1,
                won: true,
                exitDigit: 6,
                settlement: 'api',
                isVirtual: true,
                settledAt: Date.now(),
                source: 'vh_virtual',
            },
            appended: false,
            exitDigitRecorded: false,
            warnings: [],
        };
    }
}

function makeCandidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
    return {
        signalId: 'lifecycle-test',
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

describe('VirtualHookEngine — dispose lifecycle', () => {
    test('dispose releases observer and adapter', async () => {
        const adapter = new TrackedProposalAdapter();
        const ticks = new TrackedTickObserver();
        const engine = new VirtualHookEngine(adapter, ticks, new NoopPipeline(), new CaptureLogger());

        await engine.dispose();

        expect(ticks.stopped).toBe(true);
        expect(adapter.aborted).toBe(true);
    });

    test('disposed engine rejects start()', async () => {
        const engine = new VirtualHookEngine(
            new TrackedProposalAdapter(),
            new TrackedTickObserver(),
            new NoopPipeline(),
            new CaptureLogger()
        );

        await engine.dispose();

        await expect(engine.start(makeCandidate())).rejects.toThrow(VirtualHookError);
        await expect(engine.start(makeCandidate())).rejects.toThrow(/disposed/);
    });

    test('disposed engine rejects configure()', async () => {
        const engine = new VirtualHookEngine(
            new TrackedProposalAdapter(),
            new TrackedTickObserver(),
            new NoopPipeline(),
            new CaptureLogger()
        );

        await engine.dispose();

        // configure must not throw — it logs and returns.
        expect(() => engine.configure({ enabled: true })).not.toThrow();
        expect(engine.isEnabled()).toBe(false);
    });

    test('configure preserves previously-set fields (partial merge)', async () => {
        const engine = new VirtualHookEngine(
            new TrackedProposalAdapter(),
            new TrackedTickObserver(),
            new NoopPipeline(),
            new CaptureLogger()
        );

        engine.configure({ maxSteps: 7, minWins: 4 });
        engine.configure({ enabled: true });

        // enabled must be true AND maxSteps/minWins must be preserved.
        expect(engine.isEnabled()).toBe(true);
        const status = engine.getStatus();
        expect(status.maxSteps).toBe(7);
        expect(status.minWins).toBe(4);
    });
});

describe('VirtualHookEngine — run_completed logging', () => {
    test('AUTHORIZED emits vh.run_completed with full context', async () => {
        const logger = new CaptureLogger();
        const engine = new VirtualHookEngine(
            new TrackedProposalAdapter(),
            new TrackedTickObserver(),
            new NoopPipeline(),
            logger,
            { maxSteps: 3, minWins: 1, enabled: true, settlementTimeoutMs: 5_000 }
        );

        const result = await engine.start(makeCandidate());

        expect(result.decision).toBe(VHDecision.AUTHORIZED);

        const completed = logger.entries.filter(e => e.event === 'vh.run_completed');
        expect(completed.length).toBe(1);

        const ctx = completed[0].context;
        expect(ctx.decision).toBe(VHDecision.AUTHORIZED);
        expect(ctx.runId).toBe('lifecycle-test');
        expect(typeof ctx.durationMs).toBe('number');
        expect(typeof ctx.roundsCompleted).toBe('number');
        expect('wins' in ctx).toBe(true);
        expect('losses' in ctx).toBe(true);
    }, 15_000);

    test('REJECTED emits vh.run_completed with decision REJECTED', async () => {
        const logger = new CaptureLogger();
        // Sequence: [1006, 1003] → digits 6 (win >5) and 3 (loss) —
        // 1 win / 2 rounds, below minWins=2 → REJECTED at maxSteps.
        const engine = new VirtualHookEngine(
            new TrackedProposalAdapter(),
            new TrackedTickObserver([1006, 1003]),
            new NoopPipeline(),
            logger,
            { maxSteps: 2, minWins: 2, enabled: true, settlementTimeoutMs: 5_000 }
        );

        const result = await engine.start(makeCandidate());

        expect(result.decision).toBe(VHDecision.REJECTED);

        const completed = logger.entries.filter(e => e.event === 'vh.run_completed');
        expect(completed.length).toBe(1);
        expect(completed[0].context.decision).toBe(VHDecision.REJECTED);
    }, 15_000);
});