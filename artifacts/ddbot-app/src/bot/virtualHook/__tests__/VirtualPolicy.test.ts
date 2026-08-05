// =============================================================
// VirtualPolicy Tests
// =============================================================

import { VirtualPolicy } from '../VirtualPolicy';
import { VHDecision } from '../VHDecision';
import { resolveVHConfig } from '../VHConfig';

describe('VirtualPolicy', () => {
    test('AUTHORIZED when minWins reached before maxSteps', () => {
        const policy = new VirtualPolicy(resolveVHConfig({ maxSteps: 5, minWins: 3 }));
        policy.recordOutcome(true);
        policy.recordOutcome(true);
        policy.recordOutcome(true);

        const result = policy.evaluate();
        expect(result.decision).toBe(VHDecision.AUTHORIZED);
        expect(result.reason).toBe('MIN_WINS_REACHED_EARLY');
        expect(result.roundsCompleted).toBe(3);
        expect(result.wins).toBe(3);
        expect(result.losses).toBe(0);
    });

    test('REJECTED when maxSteps exhausted without enough wins', () => {
        const policy = new VirtualPolicy(resolveVHConfig({ maxSteps: 3, minWins: 3 }));
        policy.recordOutcome(true);
        policy.recordOutcome(false);
        policy.recordOutcome(false);

        const result = policy.evaluate();
        expect(result.decision).toBe(VHDecision.REJECTED);
        expect(result.reason).toBe('MAX_STEPS_REACHED');
        expect(result.roundsCompleted).toBe(3);
        expect(result.wins).toBe(1);
        expect(result.losses).toBe(2);
    });

    test('RETRY (continue) while below thresholds', () => {
        const policy = new VirtualPolicy(resolveVHConfig({ maxSteps: 3, minWins: 2 }));
        policy.recordOutcome(false);

        const result = policy.evaluate();
        expect(result.decision).toBe(VHDecision.RETRY);
        expect(result.reason).toBe('CONTINUE');
    });

    test('STOPPED when max consecutive failures exceeded', () => {
        const policy = new VirtualPolicy(resolveVHConfig({ maxSteps: 5, minWins: 3, maxConsecutiveFailures: 2 }));
        policy.recordOutcome(false, true);
        policy.recordOutcome(false, true);

        const result = policy.evaluate();
        expect(result.decision).toBe(VHDecision.STOPPED);
        expect(result.reason).toBe('MAX_CONSECUTIVE_FAILURES');
    });

    test('Authorized on final step when wins exactly meet minWins', () => {
        const policy = new VirtualPolicy(resolveVHConfig({ maxSteps: 3, minWins: 2 }));
        policy.recordOutcome(true);
        policy.recordOutcome(false);
        policy.recordOutcome(true);

        const result = policy.evaluate();
        expect(result.decision).toBe(VHDecision.AUTHORIZED);
        expect(result.reason).toBe('MIN_WINS_REACHED');
        expect(result.roundsCompleted).toBe(3);
    });

    test('reset clears all counters', () => {
        const policy = new VirtualPolicy(resolveVHConfig({ maxSteps: 5, minWins: 3 }));
        policy.recordOutcome(true);
        policy.recordOutcome(true);
        policy.recordOutcome(true);

        expect(policy.evaluate().decision).toBe(VHDecision.AUTHORIZED);

        policy.reset();
        expect(policy.roundsCompleted).toBe(0);
        expect(policy.wins).toBe(0);
        expect(policy.losses).toBe(0);

        const afterReset = policy.evaluate();
        expect(afterReset.decision).toBe(VHDecision.RETRY);
        expect(afterReset.reason).toBe('CONTINUE');
    });
});