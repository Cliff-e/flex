import {
    DEFAULT_VH_CONFIG,
    DERIV_MINIMUM_STAKE,
    resolveVHConfig,
    validateVHConfig,
} from '../VHConfig';

describe('VHConfig', () => {
    test('returns defaults when no overrides are provided', () => {
        expect(resolveVHConfig()).toEqual(DEFAULT_VH_CONFIG);
    });

    test('merges all three independent controls', () => {
        const config = resolveVHConfig({
            winThreshold: 7,
            winThresholdEnabled: false,
            lossThreshold: 4,
            lossThresholdEnabled: true,
            maxSteps: 9,
            maxStepsEnabled: false,
        });

        expect(config.winThreshold).toBe(7);
        expect(config.winThresholdEnabled).toBe(false);
        expect(config.lossThreshold).toBe(4);
        expect(config.lossThresholdEnabled).toBe(true);
        expect(config.maxSteps).toBe(9);
        expect(config.maxStepsEnabled).toBe(false);
    });

    test('zero thresholds remain zero and are valid disabled conditions', () => {
        const config = resolveVHConfig({
            winThreshold: 0,
            lossThreshold: 0,
            maxSteps: 0,
        });

        expect(config.winThreshold).toBe(0);
        expect(config.lossThreshold).toBe(0);
        expect(config.maxSteps).toBe(0);
        expect(() => validateVHConfig(config)).not.toThrow();
    });

    test('legacy minWins is migrated to winThreshold at the boundary', () => {
        const config = resolveVHConfig({ minWins: 4 });
        expect(config.winThreshold).toBe(4);
    });

    test('clamps virtual stake and retry values safely', () => {
        const config = resolveVHConfig({
            virtualStake: 0.1,
            maxProposalRetries: -1,
            maxConsecutiveFailures: -2,
            aiMaxRetries: -3,
        });
        expect(config.virtualStake).toBe(DERIV_MINIMUM_STAKE);
        expect(config.maxProposalRetries).toBe(0);
        expect(config.maxConsecutiveFailures).toBe(0);
        expect(config.aiMaxRetries).toBe(0);
    });
});