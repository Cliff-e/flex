import { VirtualPolicy } from '../VirtualPolicy';
import { VHDecision } from '../VHDecision';
import { resolveVHConfig } from '../VHConfig';

describe('VirtualPolicy', () => {
    test('authorizes on consecutive wins when the win control is enabled', () => {
        const policy = new VirtualPolicy(resolveVHConfig({
            winThreshold: 3,
            winThresholdEnabled: true,
            lossThresholdEnabled: false,
            maxStepsEnabled: false,
        }));

        policy.recordOutcome(true);
        policy.recordOutcome(true);
        expect(policy.evaluate().decision).toBe(VHDecision.RETRY);
        policy.recordOutcome(true);

        const result = policy.evaluate();
        expect(result.decision).toBe(VHDecision.AUTHORIZED);
        expect(result.reason).toBe('WIN_STREAK_REACHED');
        expect(result.consecutiveVirtualWins).toBe(3);
        expect(result.consecutiveVirtualLosses).toBe(0);
        expect(result.virtualInstanceCount).toBe(3);
    });

    test('resets win streak after a loss and authorizes on losses independently', () => {
        const policy = new VirtualPolicy(resolveVHConfig({
            winThreshold: 99,
            winThresholdEnabled: true,
            lossThreshold: 2,
            lossThresholdEnabled: true,
            maxStepsEnabled: false,
        }));

        policy.recordOutcome(true);
        policy.recordOutcome(false);
        expect(policy.consecutiveVirtualWins).toBe(0);
        expect(policy.consecutiveVirtualLosses).toBe(1);
        policy.recordOutcome(false);

        const result = policy.evaluate();
        expect(result.decision).toBe(VHDecision.AUTHORIZED);
        expect(result.reason).toBe('LOSS_STREAK_REACHED');
        expect(result.wins).toBe(1);
        expect(result.losses).toBe(2);
    });

    test('authorizes on completed VH instances when only the steps control is enabled', () => {
        const policy = new VirtualPolicy(resolveVHConfig({
            winThresholdEnabled: false,
            lossThresholdEnabled: false,
            maxSteps: 2,
            maxStepsEnabled: true,
        }));

        policy.recordOutcome(false);
        expect(policy.evaluate().decision).toBe(VHDecision.RETRY);
        policy.recordOutcome(true);

        const result = policy.evaluate();
        expect(result.decision).toBe(VHDecision.AUTHORIZED);
        expect(result.reason).toBe('MAX_STEPS_REACHED');
        expect(result.virtualInstanceCount).toBe(2);
    });

    test('disabled controls do not authorize, including positive thresholds', () => {
        const policy = new VirtualPolicy(resolveVHConfig({
            winThreshold: 1,
            winThresholdEnabled: false,
            lossThreshold: 1,
            lossThresholdEnabled: false,
            maxSteps: 1,
            maxStepsEnabled: false,
        }));

        policy.recordOutcome(true);
        const result = policy.evaluate();
        expect(result.decision).toBe(VHDecision.RETRY);
        expect(result.reason).toBe('CONTINUE');
    });

    test('zero thresholds are disabled even when their switches are on', () => {
        const policy = new VirtualPolicy(resolveVHConfig({
            winThreshold: 0,
            winThresholdEnabled: true,
            lossThreshold: 0,
            lossThresholdEnabled: true,
            maxSteps: 0,
            maxStepsEnabled: true,
        }));

        policy.recordOutcome(true);
        expect(policy.evaluate().decision).toBe(VHDecision.RETRY);
    });

    test('technical failures never count as instances, wins, or losses', () => {
        const policy = new VirtualPolicy(resolveVHConfig({
            maxConsecutiveFailures: 2,
            winThresholdEnabled: false,
            lossThresholdEnabled: false,
            maxStepsEnabled: false,
        }));

        policy.recordOutcome(false, true);
        expect(policy.virtualInstanceCount).toBe(0);
        expect(policy.roundsCompleted).toBe(0);
        expect(policy.wins).toBe(0);
        expect(policy.losses).toBe(0);
        expect(policy.evaluate().decision).toBe(VHDecision.RETRY);

        policy.recordOutcome(false, true);
        expect(policy.evaluate().decision).toBe(VHDecision.STOPPED);
        expect(policy.evaluate().reason).toBe('MAX_CONSECUTIVE_FAILURES');
    });

    test('reset clears streaks and completed-instance counters', () => {
        const policy = new VirtualPolicy(resolveVHConfig({
            winThreshold: 2,
            winThresholdEnabled: true,
        }));
        policy.recordOutcome(true);
        policy.reset();

        expect(policy.roundsCompleted).toBe(0);
        expect(policy.wins).toBe(0);
        expect(policy.losses).toBe(0);
        expect(policy.consecutiveVirtualWins).toBe(0);
        expect(policy.consecutiveVirtualLosses).toBe(0);
        expect(policy.virtualInstanceCount).toBe(0);
    });
});