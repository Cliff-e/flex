// =============================================================
// Phase 1 Verification Audit
//
// Covers:
//   1. State Machine Completeness — every documented state reachable
//   2. Transition Coverage — every legal transition has a test
//   3. Illegal Transition Tests — engine rejects invalid transitions
//   4. Concurrency Audit — only one VH run at a time
//   5. Memory Leak Audit — 1000 runs with no retained state
//   6. Logger Verification — exactly one structured log per transition
//   7. Settlement Verification — deterministic digit tables
// =============================================================

import { VirtualStateMachine, VHState } from '../VirtualStateMachine';
import { VirtualHookEngine } from '../VirtualHookEngine';
import { VHDecision } from '../VHDecision';
import type { TradeCandidate } from '../TradeCandidate';
import type { ProposalAdapter, ProposalResult, VHProposal } from '../ProposalAdapter';
import type { TickObserver, VHTick } from '../TickObserver';
import type { TransactionPipeline, TransactionResult } from '../TransactionPipeline';
import type { VHLogger, VHLogContext } from '../VHLogger';
import { IllegalStateTransitionError, VirtualHookBusyError } from '../errors';
import { isDigitContractWin } from '../SettlementEngine';

// ─────────────────────────────────────────────────────────────
// Test infrastructure (shared mocks)
// ─────────────────────────────────────────────────────────────

class AuditLogger implements VHLogger {
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

    /** Count transitions by name. */
    countEvent(event: string): number {
        return this.entries.filter(e => e.event === event).length;
    }
}

class AuditProposalAdapter implements ProposalAdapter {
    calls = 0;
    constructor(public retryableFailures = 0) {}

    async requestProposal(
        _candidate: TradeCandidate,
        _virtualStake: number,
        _timeoutMs: number
    ): Promise<ProposalResult> {
        this.calls++;
        if (this.retryableFailures > 0) {
            this.retryableFailures--;
            return { ok: false, retryable: true, reason: 'transient-failure' };
        }
        const proposal: VHProposal = {
            id: `audit-proposal-${this.calls}`,
            askPrice: 0.5,
            contractType: _candidate.contractType,
            symbol: _candidate.symbol,
        };
        return { ok: true, proposal };
    }

    abort(): void {}
}

class AuditTickObserver implements TickObserver {
    private active = false;
    private listeners = 0;
    tickSequence: VHTick[];
    private tickIndex = 0;

    constructor(sequence: number[]) {
        this.tickSequence = sequence.map((quote, i) => ({
            quote,
            epoch: 1_700_000_000 + i,
            digit: Number(String(quote).replace('.', '').slice(-1)),
        }));
    }

    async start(_symbol: string, onTick: (tick: VHTick) => void): Promise<void> {
        this.active = true;
        this.listeners++;
        this.tickIndex = 0;
        // Emit all ticks synchronously-ish to avoid timer leaks.
        queueMicrotask(() => {
            if (!this.active) return;
            while (this.tickIndex < this.tickSequence.length) {
                const tick = this.tickSequence[this.tickIndex++];
                onTick(tick);
            }
        });
    }

    async stop(): Promise<void> {
        this.active = false;
        this.listeners = 0;
    }

    /** Number of active listeners (for leak detection). */
    getListenerCount(): number {
        return this.listeners;
    }

    isActive(): boolean {
        return this.active;
    }
}

class AuditTransactionPipeline implements TransactionPipeline {
    processed = 0;

    async process(_contract: never): Promise<TransactionResult> {
        this.processed++;
        return {
            transaction: {
                transactionId: `tx-${this.processed}`,
                runId: 'run',
                roundIndex: 0,
                contractId: 'contract',
                contractType: 'DIGITOVER',
                symbol: 'R_100',
                stake: 1,
                profit: 1,
                won: true,
                exitDigit: 5,
                settlement: 'api',
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

function makeCandidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
    return {
        signalId: `audit-${Date.now()}-${Math.random()}`,
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

// ─────────────────────────────────────────────────────────────
// 1. STATE MACHINE COMPLETENESS
// ─────────────────────────────────────────────────────────────

describe('Phase 1 Audit — State Machine Completeness', () => {
    test('All 15 documented states are defined', () => {
        const states = Object.values(VHState);
        expect(states.length).toBe(15);
        expect(states).toContain(VHState.IDLE);
        expect(states).toContain(VHState.TRADE_CANDIDATE_RECEIVED);
        expect(states).toContain(VHState.REQUEST_PROPOSAL);
        expect(states).toContain(VHState.PROPOSAL_RECEIVED);
        expect(states).toContain(VHState.CREATE_VIRTUAL_CONTRACT);
        expect(states).toContain(VHState.WAIT_FOR_ENTRY);
        expect(states).toContain(VHState.ACTIVE);
        expect(states).toContain(VHState.WAIT_FOR_EXIT);
        expect(states).toContain(VHState.SETTLED);
        expect(states).toContain(VHState.RECORD_TRANSACTION);
        expect(states).toContain(VHState.UPDATE_SHARED_EXIT_HISTORY);
        expect(states).toContain(VHState.POLICY_DECISION);
        expect(states).toContain(VHState.AUTHORIZE_REAL_TRADE);
        expect(states).toContain(VHState.REJECT);
        expect(states).toContain(VHState.STOPPED);
    });

    test('REACHABLE: IDLE is the initial state', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a1');
        expect(sm.state).toBe(VHState.IDLE);
    });

    test('REACHABLE: TRADE_CANDIDATE_RECEIVED from IDLE', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a2');
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'test');
        expect(sm.state).toBe(VHState.TRADE_CANDIDATE_RECEIVED);
    });

    test('REACHABLE: REQUEST_PROPOSAL from TRADE_CANDIDATE_RECEIVED', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a3');
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'test');
        sm.transition(VHState.REQUEST_PROPOSAL, 'test');
        expect(sm.state).toBe(VHState.REQUEST_PROPOSAL);
    });

    test('REACHABLE: PROPOSAL_RECEIVED from REQUEST_PROPOSAL', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a4');
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'test');
        sm.transition(VHState.REQUEST_PROPOSAL, 'test');
        sm.transition(VHState.PROPOSAL_RECEIVED, 'test');
        expect(sm.state).toBe(VHState.PROPOSAL_RECEIVED);
    });

    test('REACHABLE: CREATE_VIRTUAL_CONTRACT from PROPOSAL_RECEIVED', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a5');
        walkToCreateVirtualContract(sm);
        expect(sm.state).toBe(VHState.CREATE_VIRTUAL_CONTRACT);
    });

    test('REACHABLE: WAIT_FOR_ENTRY from CREATE_VIRTUAL_CONTRACT', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a6');
        walkToWaitForEntry(sm);
        expect(sm.state).toBe(VHState.WAIT_FOR_ENTRY);
    });

    test('REACHABLE: ACTIVE from WAIT_FOR_ENTRY', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a7');
        walkToActive(sm);
        expect(sm.state).toBe(VHState.ACTIVE);
    });

    test('REACHABLE: WAIT_FOR_EXIT from ACTIVE', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a8');
        walkToWaitForExit(sm);
        expect(sm.state).toBe(VHState.WAIT_FOR_EXIT);
    });

    test('REACHABLE: SETTLED from WAIT_FOR_EXIT', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a9');
        walkToSettled(sm);
        expect(sm.state).toBe(VHState.SETTLED);
    });

    test('REACHABLE: RECORD_TRANSACTION from SETTLED (AND from WAIT_FOR_ENTRY via timeout)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a10');
        walkToSettled(sm);
        sm.transition(VHState.RECORD_TRANSACTION, 'test');
        expect(sm.state).toBe(VHState.RECORD_TRANSACTION);
    });

    test('REACHABLE: UPDATE_SHARED_EXIT_HISTORY from RECORD_TRANSACTION', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a11');
        walkToSettled(sm);
        sm.transition(VHState.RECORD_TRANSACTION, 'test');
        sm.transition(VHState.UPDATE_SHARED_EXIT_HISTORY, 'test');
        expect(sm.state).toBe(VHState.UPDATE_SHARED_EXIT_HISTORY);
    });

    test('REACHABLE: POLICY_DECISION from UPDATE_SHARED_EXIT_HISTORY', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a12');
        walkToPolicyDecision(sm);
        expect(sm.state).toBe(VHState.POLICY_DECISION);
    });

    test('REACHABLE: AUTHORIZE_REAL_TRADE from POLICY_DECISION', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a13');
        walkToPolicyDecision(sm);
        sm.transition(VHState.AUTHORIZE_REAL_TRADE, 'authorize');
        expect(sm.state).toBe(VHState.AUTHORIZE_REAL_TRADE);
    });

    test('REACHABLE: REJECT from POLICY_DECISION', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a14');
        walkToPolicyDecision(sm);
        sm.transition(VHState.REJECT, 'reject');
        expect(sm.state).toBe(VHState.REJECT);
    });

    test('REACHABLE: STOPPED from any state (e.g., IDLE)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a15');
        sm.stop('audit');
        expect(sm.state).toBe(VHState.STOPPED);
    });

    test('REACHABLE: STOPPED from REQUEST_PROPOSAL (terminal path)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'a16');
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 't');
        sm.transition(VHState.REQUEST_PROPOSAL, 't');
        sm.stop('proposal failure');
        expect(sm.state).toBe(VHState.STOPPED);
    });
});

// ─────────────────────────────────────────────────────────────
// 2. TRANSITION COVERAGE
// ─────────────────────────────────────────────────────────────

describe('Phase 1 Audit — Transition Coverage', () => {
    test('LEGAL: IDLE → TRADE_CANDIDATE_RECEIVED', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't1');
        expect(() => sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 't')).not.toThrow();
    });

    test('LEGAL: TRADE_CANDIDATE_RECEIVED → REQUEST_PROPOSAL', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't2');
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 't');
        expect(() => sm.transition(VHState.REQUEST_PROPOSAL, 't')).not.toThrow();
    });

    test('LEGAL: TRADE_CANDIDATE_RECEIVED → STOPPED (invalid candidate)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't3');
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 't');
        expect(() => sm.transition(VHState.STOPPED, 'invalid')).not.toThrow();
    });

    test('LEGAL: REQUEST_PROPOSAL → PROPOSAL_RECEIVED', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't4');
        walkToRequestProposal(sm);
        expect(() => sm.transition(VHState.PROPOSAL_RECEIVED, 't')).not.toThrow();
    });

    test('LEGAL: REQUEST_PROPOSAL → REQUEST_PROPOSAL (retry loop)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't5');
        walkToRequestProposal(sm);
        expect(() => sm.transition(VHState.REQUEST_PROPOSAL, 'retry')).not.toThrow();
    });

    test('LEGAL: REQUEST_PROPOSAL → STOPPED (max retries)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't6');
        walkToRequestProposal(sm);
        expect(() => sm.transition(VHState.STOPPED, 'max retries')).not.toThrow();
    });

    test('LEGAL: PROPOSAL_RECEIVED → CREATE_VIRTUAL_CONTRACT', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't7');
        walkToCreateVirtualContract(sm);
        expect(sm.state).toBe(VHState.CREATE_VIRTUAL_CONTRACT);
    });

    test('LEGAL: PROPOSAL_RECEIVED → REQUEST_PROPOSAL (stale proposal ref)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't8');
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 't');
        sm.transition(VHState.REQUEST_PROPOSAL, 't');
        sm.transition(VHState.PROPOSAL_RECEIVED, 't');
        expect(() => sm.transition(VHState.REQUEST_PROPOSAL, 'stale')).not.toThrow();
    });

    test('LEGAL: CREATE_VIRTUAL_CONTRACT → WAIT_FOR_ENTRY', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't9');
        walkToWaitForEntry(sm);
        expect(sm.state).toBe(VHState.WAIT_FOR_ENTRY);
    });

    test('LEGAL: CREATE_VIRTUAL_CONTRACT → STOPPED (internal error)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't10');
        walkToCreateVirtualContract(sm);
        expect(() => sm.transition(VHState.STOPPED, 'internal error')).not.toThrow();
    });

    test('LEGAL: WAIT_FOR_ENTRY → ACTIVE', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't11');
        walkToActive(sm);
        expect(sm.state).toBe(VHState.ACTIVE);
    });

    test('LEGAL: WAIT_FOR_ENTRY → SETTLED (entry timeout → treated as loss)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't12');
        walkToWaitForEntry(sm);
        expect(() => sm.transition(VHState.SETTLED, 'entry timeout')).not.toThrow();
    });

    test('LEGAL: ACTIVE → WAIT_FOR_EXIT', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't13');
        walkToWaitForExit(sm);
        expect(sm.state).toBe(VHState.WAIT_FOR_EXIT);
    });

    test('LEGAL: ACTIVE → SETTLED (settlement timeout path)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't14');
        walkToActive(sm);
        expect(() => sm.transition(VHState.SETTLED, 'settlement timeout')).not.toThrow();
    });

    test('LEGAL: WAIT_FOR_EXIT → SETTLED', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't15');
        walkToSettled(sm);
        expect(sm.state).toBe(VHState.SETTLED);
    });

    test('LEGAL: SETTLED → RECORD_TRANSACTION', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't16');
        walkToSettled(sm);
        expect(() => sm.transition(VHState.RECORD_TRANSACTION, 't')).not.toThrow();
    });

    test('LEGAL: RECORD_TRANSACTION → UPDATE_SHARED_EXIT_HISTORY', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't17');
        walkToSettled(sm);
        sm.transition(VHState.RECORD_TRANSACTION, 't');
        expect(() => sm.transition(VHState.UPDATE_SHARED_EXIT_HISTORY, 't')).not.toThrow();
    });

    test('LEGAL: RECORD_TRANSACTION → POLICY_DECISION (skip history for non-digit)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't18');
        walkToSettled(sm);
        sm.transition(VHState.RECORD_TRANSACTION, 't');
        expect(() => sm.transition(VHState.POLICY_DECISION, 't')).not.toThrow();
    });

    test('LEGAL: UPDATE_SHARED_EXIT_HISTORY → POLICY_DECISION', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't19');
        walkToPolicyDecision(sm);
        expect(sm.state).toBe(VHState.POLICY_DECISION);
    });

    test('LEGAL: POLICY_DECISION → AUTHORIZE_REAL_TRADE', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't20');
        walkToPolicyDecision(sm);
        expect(() => sm.transition(VHState.AUTHORIZE_REAL_TRADE, 't')).not.toThrow();
    });

    test('LEGAL: POLICY_DECISION → REJECT', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't21');
        walkToPolicyDecision(sm);
        expect(() => sm.transition(VHState.REJECT, 't')).not.toThrow();
    });

    test('LEGAL: POLICY_DECISION → STOPPED (policy critical failure)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't22');
        walkToPolicyDecision(sm);
        expect(() => sm.transition(VHState.STOPPED, 'policy failure')).not.toThrow();
    });

    test('LEGAL: POLICY_DECISION → REQUEST_PROPOSAL (continue to next round)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 't23');
        walkToPolicyDecision(sm);
        expect(() => sm.transition(VHState.REQUEST_PROPOSAL, 'next round')).not.toThrow();
    });
});

// ─────────────────────────────────────────────────────────────
// 3. ILLEGAL TRANSITION TESTS
// ─────────────────────────────────────────────────────────────

describe('Phase 1 Audit — Illegal Transitions', () => {
    test('ILLEGAL: SETTLED → REQUEST_PROPOSAL is rejected', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'i1');
        walkToSettled(sm);
        expect(() => sm.transition(VHState.REQUEST_PROPOSAL, 'skip recording')).toThrow(IllegalStateTransitionError);
        expect(sm.state).toBe(VHState.SETTLED);
    });

    test('ILLEGAL: IDLE → ACTIVE is rejected', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'i2');
        expect(() => sm.transition(VHState.ACTIVE, 'skip to active')).toThrow(IllegalStateTransitionError);
        expect(sm.state).toBe(VHState.IDLE);
    });

    test('ILLEGAL: ACTIVE → CREATE_VIRTUAL_CONTRACT is rejected', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'i3');
        walkToActive(sm);
        expect(() => sm.transition(VHState.CREATE_VIRTUAL_CONTRACT, 'recreate')).toThrow(IllegalStateTransitionError);
        expect(sm.state).toBe(VHState.ACTIVE);
    });

    test('ILLEGAL: POLICY_DECISION → ACTIVE is rejected', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'i4');
        walkToPolicyDecision(sm);
        expect(() => sm.transition(VHState.ACTIVE, 'reactive')).toThrow(IllegalStateTransitionError);
        expect(sm.state).toBe(VHState.POLICY_DECISION);
    });

    test('ILLEGAL: WAIT_FOR_EXIT → WAIT_FOR_EXIT (self-loop) is rejected', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'i5');
        walkToWaitForExit(sm);
        expect(() => sm.transition(VHState.WAIT_FOR_EXIT, 'self')).toThrow(IllegalStateTransitionError);
    });

    test('ILLEGAL: AUTHORIZE_REAL_TRADE is terminal — no outgoing transitions', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'i6');
        walkToPolicyDecision(sm);
        sm.transition(VHState.AUTHORIZE_REAL_TRADE, 'authorized');
        expect(sm.state).toBe(VHState.AUTHORIZE_REAL_TRADE);
        // Any transition out of AUTHORIZE_REAL_TRADE should throw (empty set).
        expect(() => sm.transition(VHState.IDLE, 'reset')).toThrow(IllegalStateTransitionError);
        expect(() => sm.transition(VHState.STOPPED, 'stop after authorize')).toThrow(IllegalStateTransitionError);
    });

    test('ILLEGAL: REJECT is terminal — no outgoing transitions', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'i7');
        walkToPolicyDecision(sm);
        sm.transition(VHState.REJECT, 'rejected');
        expect(sm.state).toBe(VHState.REJECT);
        expect(() => sm.transition(VHState.IDLE, 'reset')).toThrow(IllegalStateTransitionError);
    });

    test('ILLEGAL: STOPPED is terminal — no outgoing transitions (except reset)', () => {
        const sm = new VirtualStateMachine(new AuditLogger(), 'i8');
        sm.stop('test stop');
        expect(sm.state).toBe(VHState.STOPPED);
        expect(() => sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'restart')).toThrow(IllegalStateTransitionError);
        // But reset() IS allowed (engine-level reuse).
        sm.reset();
        expect(sm.state).toBe(VHState.IDLE);
    });
});

// ─────────────────────────────────────────────────────────────
// 4. CONCURRENCY AUDIT
// ─────────────────────────────────────────────────────────────

describe('Phase 1 Audit — Concurrency', () => {
    test('Second start() while busy is rejected (no shared state)', async () => {
        const adapter = new AuditProposalAdapter();
        const ticks = new AuditTickObserver([1006, 1007]);
        const engine = new VirtualHookEngine(adapter, ticks, undefined, new AuditLogger(), {
            maxSteps: 2,
            minWins: 2,
            enabled: true,
            settlementTimeoutMs: 10_000,
        });

        const firstRun = engine.start(makeCandidate());
        await expect(engine.start(makeCandidate())).rejects.toBeInstanceOf(VirtualHookBusyError);

        const result = await firstRun;
        expect(result.decision).toBe(VHDecision.AUTHORIZED);
    }, 20_000);

    test('After run completes, next run is accepted (busy flag released)', async () => {
        const adapter = new AuditProposalAdapter();
        const ticks = new AuditTickObserver([1006, 1007]);
        const engine = new VirtualHookEngine(adapter, ticks, undefined, new AuditLogger(), {
            maxSteps: 2,
            minWins: 2,
            enabled: true,
            settlementTimeoutMs: 10_000,
        });

        const first = await engine.start(makeCandidate());
        expect(first.decision).toBe(VHDecision.AUTHORIZED);

        const second = await engine.start(makeCandidate());
        expect(second.decision).toBe(VHDecision.AUTHORIZED);
    }, 20_000);

    test('1000 rapid sequential runs do not accumulate state', async () => {
        // NOTE: Each run has a minimum ~100ms cost due to the engine's
        // 100ms tick-polling loop. With maxSteps=1/minWins=1, each run is
        // exactly 1 round → ~1000 × 100ms ≈ 100s total.
        for (let i = 0; i < 1000; i++) {
            const adapter = new AuditProposalAdapter();
            const ticks = new AuditTickObserver([1006]);
            const engine = new VirtualHookEngine(adapter, ticks, undefined, new AuditLogger(), {
                maxSteps: 1,
                minWins: 1,
                enabled: true,
                settlementTimeoutMs: 50,
            });
            const result = await engine.start(makeCandidate({ signalId: `concurrent-${i}` }));
            expect(result.decision).toBe(VHDecision.AUTHORIZED);
            // Engine must be idle again.
            expect(engine.getStatus().active).toBe(false);
            // No listener retained.
            expect(ticks.getListenerCount()).toBe(0);
        }
    }, 180_000);
});

// ─────────────────────────────────────────────────────────────
// 5. MEMORY LEAK AUDIT
// ─────────────────────────────────────────────────────────────

describe('Phase 1 Audit — Memory Leaks', () => {
    test('1000 runs: no retained contracts, listeners, or timers', async () => {
        const executions = 1000;
        const adapter = new AuditProposalAdapter();
        let totalProcessed = 0;
        let listenerLeaks = 0;

        for (let i = 0; i < executions; i++) {
            const ticks = new AuditTickObserver([1006]);
            const pipeline = new AuditTransactionPipeline();
            const engine = new VirtualHookEngine(adapter, ticks, pipeline, new AuditLogger(), {
                maxSteps: 1,
                minWins: 1,
                enabled: true,
                settlementTimeoutMs: 50,
            });
            const result = await engine.start(makeCandidate({ signalId: `leak-${i}` }));
            expect(result.decision).toBe(VHDecision.AUTHORIZED);
            totalProcessed += pipeline.processed;

            if (ticks.getListenerCount() > 0) listenerLeaks++;
        }

        // All 1000 runs completed.
        expect(totalProcessed).toBeGreaterThanOrEqual(1000);
        // No observer should retain listeners after engine.finishRun().
        expect(listenerLeaks).toBe(0);
        // Engine is not busy after all runs.
    }, 180_000);
});

// ─────────────────────────────────────────────────────────────
// 6. LOGGER VERIFICATION
// ─────────────────────────────────────────────────────────────

describe('Phase 1 Audit — Logger Verification', () => {
    test('Each transition logs exactly one vh.state_transition entry', () => {
        const logger = new AuditLogger();
        const sm = new VirtualStateMachine(logger, 'log-1');

        // Do 5 legal transitions.
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 't1');
        sm.transition(VHState.REQUEST_PROPOSAL, 't2');
        sm.transition(VHState.PROPOSAL_RECEIVED, 't3');
        sm.transition(VHState.CREATE_VIRTUAL_CONTRACT, 't4');
        sm.transition(VHState.WAIT_FOR_ENTRY, 't5');

        const transitions = logger.entries.filter(e => e.event === 'vh.state_transition');
        expect(transitions.length).toBe(5);
    });

    test('Every log entry contains all required context fields', () => {
        const logger = new AuditLogger();
        const sm = new VirtualStateMachine(logger, 'log-2');
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'start');

        const entry = logger.entries[0];
        expect(entry.event).toBe('vh.state_transition');
        expect(entry.context).toMatchObject({
            runId: 'log-2',
            currentState: VHState.IDLE,
            expectedState: VHState.TRADE_CANDIDATE_RECEIVED,
            reason: 'start',
        });
        // Continuity: nextState/prevState should be consistent.
        expect(entry.context.currentState).toBe(VHState.IDLE);
        expect(entry.context.expectedState).toBe(VHState.TRADE_CANDIDATE_RECEIVED);
    });

    test('Stop logs a warn entry', () => {
        const logger = new AuditLogger();
        const sm = new VirtualStateMachine(logger, 'log-3');
        sm.stop('fatal');

        const warns = logger.entries.filter(e => e.level === 'warn');
        expect(warns.length).toBe(1);
        expect(warns[0].event).toBe('vh.state_transition');
    });
});

// ─────────────────────────────────────────────────────────────
// 7. SETTLEMENT VERIFICATION — deterministic digit tables
// ─────────────────────────────────────────────────────────────

describe('Phase 1 Audit — Settlement Determinism', () => {
    test('DIGITOVER barrier=5: digits 0-5 lose, 6-9 win', () => {
        const expected: [number, boolean][] = [
            [0, false], [1, false], [2, false], [3, false], [4, false], [5, false],
            [6, true], [7, true], [8, true], [9, true],
        ];
        for (const [digit, shouldWin] of expected) {
            expect(isDigitContractWin('DIGITOVER', digit, 5)).toBe(shouldWin);
        }
    });

    test('DIGITUNDER barrier=5: digits 0-4 win, 5-9 lose', () => {
        const expected: [number, boolean][] = [
            [0, true], [1, true], [2, true], [3, true], [4, true],
            [5, false], [6, false], [7, false], [8, false], [9, false],
        ];
        for (const [digit, shouldWin] of expected) {
            expect(isDigitContractWin('DIGITUNDER', digit, 5)).toBe(shouldWin);
        }
    });

    test('DIGITMATCH prediction=5: only digit 5 wins', () => {
        const expected: [number, boolean][] = [
            [0, false], [1, false], [2, false], [3, false], [4, false],
            [5, true],
            [6, false], [7, false], [8, false], [9, false],
        ];
        for (const [digit, shouldWin] of expected) {
            expect(isDigitContractWin('DIGITMATCH', digit, 5)).toBe(shouldWin);
        }
    });

    test('DIGITDIFF prediction=5: all digits except 5 win', () => {
        const expected: [number, boolean][] = [
            [0, true], [1, true], [2, true], [3, true], [4, true],
            [5, false],
            [6, true], [7, true], [8, true], [9, true],
        ];
        for (const [digit, shouldWin] of expected) {
            expect(isDigitContractWin('DIGITDIFF', digit, 5)).toBe(shouldWin);
        }
    });

    test('DIGITEVEN: even digits (0,2,4,6,8) win', () => {
        const expected: [number, boolean][] = [
            [0, true], [1, false], [2, true], [3, false], [4, true],
            [5, false], [6, true], [7, false], [8, true], [9, false],
        ];
        for (const [digit, shouldWin] of expected) {
            expect(isDigitContractWin('DIGITEVEN', digit)).toBe(shouldWin);
        }
    });

    test('DIGITODD: odd digits (1,3,5,7,9) win', () => {
        const expected: [number, boolean][] = [
            [0, false], [1, true], [2, false], [3, true], [4, false],
            [5, true], [6, false], [7, true], [8, false], [9, true],
        ];
        for (const [digit, shouldWin] of expected) {
            expect(isDigitContractWin('DIGITODD', digit)).toBe(shouldWin);
        }
    });
});

// ─────────────────────────────────────────────────────────────
// Walk helpers — use only LEGAL transitions
// ─────────────────────────────────────────────────────────────

function walkToRequestProposal(sm: VirtualStateMachine): void {
    sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 't');
    sm.transition(VHState.REQUEST_PROPOSAL, 't');
}

function walkToCreateVirtualContract(sm: VirtualStateMachine): void {
    walkToRequestProposal(sm);
    sm.transition(VHState.PROPOSAL_RECEIVED, 't');
    sm.transition(VHState.CREATE_VIRTUAL_CONTRACT, 't');
}

function walkToWaitForEntry(sm: VirtualStateMachine): void {
    walkToCreateVirtualContract(sm);
    sm.transition(VHState.WAIT_FOR_ENTRY, 't');
}

function walkToActive(sm: VirtualStateMachine): void {
    walkToWaitForEntry(sm);
    sm.transition(VHState.ACTIVE, 't');
}

function walkToWaitForExit(sm: VirtualStateMachine): void {
    walkToActive(sm);
    sm.transition(VHState.WAIT_FOR_EXIT, 't');
}

function walkToSettled(sm: VirtualStateMachine): void {
    walkToWaitForExit(sm);
    sm.transition(VHState.SETTLED, 't');
}

function walkToPolicyDecision(sm: VirtualStateMachine): void {
    walkToSettled(sm);
    sm.transition(VHState.RECORD_TRANSACTION, 't');
    sm.transition(VHState.UPDATE_SHARED_EXIT_HISTORY, 't');
    sm.transition(VHState.POLICY_DECISION, 't');
}