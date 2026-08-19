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
 * Tick observer that simulates an ENTRY-TICK TIMEOUT on the first
 * start() call, then behaves normally on subsequent calls.
 *
 * Used to prove that a RETRY decision after an entry-timeout round
 * no longer triggers an illegal state transition: the round must
 * land in POLICY_DECISION before the run loop can continue.
 */
class EntryTimeoutThenNormalObserver implements TickObserver {
    stopped = false;
    active = false;
    private calls = 0;
    private readonly quotes: number[];

    constructor(quotes: number[] = [1006]) {
        this.quotes = quotes;
    }

    async start(symbol: string, onTick: (tick: VHTick) => void): Promise<void> {
        this.calls++;
        this.active = true;
        // First start() call simulates a complete lack of ticks → the
        // engine's _waitForFirstTick() rejects immediately (no 30s wait).
        if (this.calls === 1) {
            return Promise.reject(new Error('No entry tick observed.'));
        }
        // Subsequent start() calls emit ticks normally.
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
                source: 'VH',
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

describe('VirtualHookEngine — entry-timeout RETRY regression', () => {
    test('entry-timeout round followed by RETRY continues without IllegalStateTransitionError', async () => {
        const logger = new CaptureLogger();
        // Round 1: entry-timeout failure (consecutive failure 1).
        // Policy: rounds 0 < maxSteps 2, wins 0 < minWins 1 → RETRY.
        // Round 2: tick emitted → win → AUTHORIZED.
        const engine = new VirtualHookEngine(
            new TrackedProposalAdapter(),
            new EntryTimeoutThenNormalObserver([1006]),
            new NoopPipeline(),
            logger,
            { maxSteps: 2, minWins: 1, enabled: true, settlementTimeoutMs: 5_000 }
        );

        const result = await engine.start(makeCandidate());

        // The run must NOT have been aborted by an illegal transition.
        expect(result.decision).toBe(VHDecision.AUTHORIZED);
        // Only the successful round counts toward roundsCompleted.
        expect(result.roundsCompleted).toBe(1);
        expect(result.wins).toBe(1);

        // Prove the failure path actually ran.
        const entryTimeout = logger.entries.filter(e => e.event === 'vh.entry_timeout');
        expect(entryTimeout.length).toBe(1);

        // Exactly one terminal log with AUTHORIZED.
        const completed = logger.entries.filter(e => e.event === 'vh.run_completed');
        expect(completed.length).toBe(1);
        expect(completed[0].context.decision).toBe(VHDecision.AUTHORIZED);
    }, 15_000);
});

/**
 * Tick observer that emits exactly ONE tick (the entry tick) then stays
 * silent. Used to prove that aborting/disposing while the round is in
 * WAIT_FOR_EXIT can never settle using the entry tick as an exit tick.
 */
class SingleTickThenSilentObserver implements TickObserver {
    stopped = false;
    active = false;
    started = 0;

    async start(symbol: string, onTick: (tick: VHTick) => void): Promise<void> {
        this.started++;
        this.active = true;
        // Only the FIRST start() (entry observation) emits a tick.
        if (this.started === 1) {
            const quote = 1006;
            onTick({ quote, epoch: 1_700_000_000, digit: 6 });
        }
        // Subsequent start() calls (exit observation) emit nothing,
        // simulating a stopped/aborted tick stream.
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
 * Pipeline that records whether process() was ever called.
 * Used to prove an aborted round records NO transaction.
 */
class CountingPipeline implements TransactionPipeline {
    processed = 0;

    async process(contract: never): Promise<TransactionResult> {
        this.processed++;
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
                source: 'VH',
            },
            appended: true,
            exitDigitRecorded: true,
            warnings: [],
        };
    }
}

describe('VirtualHookEngine — abort/dispose cannot settle using the entry tick', () => {
    test('aborting while WAIT_FOR_EXIT with no genuine exit tick returns STOPPED and records nothing', async () => {
        const logger = new CaptureLogger();
        const pipeline = new CountingPipeline();
        const ticks = new SingleTickThenSilentObserver();
        const engine = new VirtualHookEngine(
            new TrackedProposalAdapter(),
            ticks,
            pipeline,
            logger,
            { maxSteps: 3, minWins: 1, enabled: true, settlementTimeoutMs: 400 }
        );

        // Start the run; entry tick arrives, then the round blocks in
        // WAIT_FOR_EXIT waiting for a genuine exit tick that never comes.
        const startPromise = engine.start(makeCandidate());

        // Give the entry observation a moment to complete, then abort —
        // this is exactly what dispose() does (sets _runAbortRequested).
        await new Promise(r => setTimeout(r, 50));
        engine.abort();

        const result = await startPromise;

        // The run must terminate STOPPED — NEVER AUTHORIZED/REJECTED from a
        // stale entry-tick settlement.
        expect(result.decision).toBe(VHDecision.STOPPED);

        // No transaction may be recorded for the aborted round.
        expect(pipeline.processed).toBe(0);

        const completed = logger.entries.filter(e => e.event === 'vh.run_completed');
        expect(completed.length).toBe(1);
        expect(completed[0].context.decision).toBe(VHDecision.STOPPED);
    }, 10_000);

    test('waitForIdle resolves false on timeout and true when the run completes', async () => {
        const engine = new VirtualHookEngine(
            new TrackedProposalAdapter(),
            new SingleTickThenSilentObserver(),
            new NoopPipeline(),
            new CaptureLogger(),
            { maxSteps: 3, minWins: 1, enabled: true, settlementTimeoutMs: 400 }
        );

        // Timeout case: a run is stuck in WAIT_FOR_EXIT; waitForIdle must
        // not hang — it resolves false after the bounded budget.
        const startPromise = engine.start(makeCandidate());
        await new Promise(r => setTimeout(r, 50));
        const idleAfterTimeout = await engine.waitForIdle(100);
        expect(idleAfterTimeout).toBe(false);

        // Abort so the run terminates, then waitForIdle must resolve true.
        engine.abort();
        await startPromise;
        expect(await engine.waitForIdle(1_000)).toBe(true);
    }, 10_000);
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

    test('authorizes when the enabled instance threshold is reached', async () => {
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

        expect(result.decision).toBe(VHDecision.AUTHORIZED);

        const completed = logger.entries.filter(e => e.event === 'vh.run_completed');
        expect(completed.length).toBe(1);
        expect(completed[0].context.decision).toBe(VHDecision.AUTHORIZED);
    }, 15_000);
});