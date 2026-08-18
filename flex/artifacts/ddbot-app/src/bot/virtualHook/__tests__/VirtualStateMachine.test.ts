// =============================================================
// VirtualStateMachine Tests
// =============================================================

import { VirtualStateMachine, VHState, VH_STATE_INFO } from '../VirtualStateMachine';
import { IllegalStateTransitionError } from '../errors';
import type { VHLogger } from '../VHLogger';

class TestLogger implements VHLogger {
    entries: { level: string; event: string; context: unknown }[] = [];
    info(event: string, context: never): void {
        this.entries.push({ level: 'info', event, context });
    }
    warn(event: string, context: never): void {
        this.entries.push({ level: 'warn', event, context });
    }
    error(event: string, context: never): void {
        this.entries.push({ level: 'error', event, context });
    }
    debug(event: string, context: never): void {
        this.entries.push({ level: 'debug', event, context });
    }
}

function makeMachine() {
    const logger = new TestLogger();
    const sm = new VirtualStateMachine(logger, 'test-run');
    return { sm, logger };
}

describe('VirtualStateMachine', () => {
    test('Starts in IDLE', () => {
        const { sm } = makeMachine();
        expect(sm.state).toBe(VHState.IDLE);
    });

    test('Legal transition: IDLE → TRADE_CANDIDATE_RECEIVED', () => {
        const { sm, logger } = makeMachine();
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'start() called');
        expect(sm.state).toBe(VHState.TRADE_CANDIDATE_RECEIVED);
        expect(logger.entries.length).toBe(1);
        expect(logger.entries[0].event).toBe('vh.state_transition');
    });

    test('Full happy-path lifecycle transition succeeds', () => {
        const { sm } = makeMachine();
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'start');
        sm.transition(VHState.REQUEST_PROPOSAL, 'validated');
        sm.transition(VHState.PROPOSAL_RECEIVED, 'proposal');
        sm.transition(VHState.CREATE_VIRTUAL_CONTRACT, 'created');
        sm.transition(VHState.WAIT_FOR_ENTRY, 'entry');
        sm.transition(VHState.ACTIVE, 'active');
        sm.transition(VHState.WAIT_FOR_EXIT, 'exit');
        sm.transition(VHState.SETTLED, 'settled');
        sm.transition(VHState.RECORD_TRANSACTION, 'record');
        sm.transition(VHState.UPDATE_SHARED_EXIT_HISTORY, 'history');
        sm.transition(VHState.POLICY_DECISION, 'policy');
        sm.transition(VHState.AUTHORIZE_REAL_TRADE, 'authorized');
        expect(sm.state).toBe(VHState.AUTHORIZE_REAL_TRADE);
    });

    test('Illegal transition throws IllegalStateTransitionError', () => {
        const { sm } = makeMachine();
        // IDLE → REQUEST_PROPOSAL is illegal (must go through TRADE_CANDIDATE_RECEIVED).
        expect(() => sm.transition(VHState.REQUEST_PROPOSAL, 'illegal')).toThrow(IllegalStateTransitionError);
        expect(sm.state).toBe(VHState.IDLE);
    });

    test('Illegal transition after ACTIVE → IDLE throws', () => {
        const { sm } = makeMachine();
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'start');
        sm.transition(VHState.REQUEST_PROPOSAL, 'validated');
        sm.transition(VHState.PROPOSAL_RECEIVED, 'proposal');
        sm.transition(VHState.CREATE_VIRTUAL_CONTRACT, 'created');
        sm.transition(VHState.WAIT_FOR_ENTRY, 'entry');
        sm.transition(VHState.ACTIVE, 'active');

        // ACTIVE → IDLE is illegal.
        expect(() => sm.transition(VHState.IDLE, 'illegal')).toThrow(IllegalStateTransitionError);
    });

    test('stop() forces STOPPED from any state', () => {
        const { sm } = makeMachine();
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'start');
        sm.stop('irrecoverable error');
        expect(sm.state).toBe(VHState.STOPPED);
    });

    test('reset() returns to IDLE', () => {
        const { sm } = makeMachine();
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'start');
        sm.transition(VHState.REQUEST_PROPOSAL, 'validated');
        sm.reset();
        expect(sm.state).toBe(VHState.IDLE);
    });

    test('nextRound() from POLICY_DECISION returns to REQUEST_PROPOSAL', () => {
        const { sm } = makeMachine();
        sm.transition(VHState.TRADE_CANDIDATE_RECEIVED, 'start');
        sm.transition(VHState.REQUEST_PROPOSAL, 'validated');
        sm.transition(VHState.PROPOSAL_RECEIVED, 'proposal');
        sm.transition(VHState.CREATE_VIRTUAL_CONTRACT, 'created');
        sm.transition(VHState.WAIT_FOR_ENTRY, 'entry');
        sm.transition(VHState.ACTIVE, 'active');
        sm.transition(VHState.WAIT_FOR_EXIT, 'exit');
        sm.transition(VHState.SETTLED, 'settled');
        sm.transition(VHState.RECORD_TRANSACTION, 'record');
        sm.transition(VHState.UPDATE_SHARED_EXIT_HISTORY, 'history');
        sm.transition(VHState.POLICY_DECISION, 'policy');
        sm.nextRound('continue observing');
        expect(sm.state).toBe(VHState.REQUEST_PROPOSAL);
    });

    test('Every state has metadata defined', () => {
        for (const state of Object.values(VHState)) {
            const info = VH_STATE_INFO[state];
            expect(info).toBeDefined();
            expect(typeof info.entryConditions).toBe('string');
            expect(typeof info.exitConditions).toBe('string');
            expect(typeof info.failureBehavior).toBe('string');
            expect(typeof info.retryBehavior).toBe('string');
        }
    });

    test('getStateInfo returns current state details', () => {
        const { sm } = makeMachine();
        const info = sm.getStateInfo(VHState.REQUEST_PROPOSAL);
        expect(info.entryConditions).toContain('Candidate validated');
    });
});