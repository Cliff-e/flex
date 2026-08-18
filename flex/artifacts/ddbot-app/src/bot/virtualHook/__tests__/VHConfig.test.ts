// =============================================================
// VHConfig Tests — Phase 8 configuration hardening
//
// Proves:
//   • resolveVHConfig normalizes (clamps) invalid values.
//   • validateVHConfig rejects impossible configurations.
//   • Partial configuration preserves previously-set fields.
// =============================================================

import {
    DEFAULT_VH_CONFIG,
    DERIV_MINIMUM_STAKE,
    resolveVHConfig,
    validateVHConfig,
} from '../VHConfig';

describe('VHConfig — resolveVHConfig normalization', () => {
    test('returns defaults when no overrides provided', () => {
        expect(resolveVHConfig()).toEqual(DEFAULT_VH_CONFIG);
    });

    test('merges partial overrides onto defaults', () => {
        const config = resolveVHConfig({ maxSteps: 7, minWins: 4 });
        expect(config.maxSteps).toBe(7);
        expect(config.minWins).toBe(4);
        // Untouched fields keep defaults.
        expect(config.enabled).toBe(false);
        expect(config.virtualStake).toBe(DEFAULT_VH_CONFIG.virtualStake);
    });

    test('clamps maxSteps below 1 to 1', () => {
        expect(resolveVHConfig({ maxSteps: 0 }).maxSteps).toBe(1);
        expect(resolveVHConfig({ maxSteps: -5 }).maxSteps).toBe(1);
    });

    test('clamps minWins below 1 to 1', () => {
        expect(resolveVHConfig({ minWins: 0 }).minWins).toBe(1);
        expect(resolveVHConfig({ minWins: -3 }).minWins).toBe(1);
    });

    test('clamps virtualStake below Deriv minimum', () => {
        expect(resolveVHConfig({ virtualStake: 0.1 }).virtualStake).toBe(DERIV_MINIMUM_STAKE);
    });

    test('clamps negative retry counts to 0', () => {
        expect(resolveVHConfig({ maxProposalRetries: -1 }).maxProposalRetries).toBe(0);
        expect(resolveVHConfig({ maxConsecutiveFailures: -2 }).maxConsecutiveFailures).toBe(0);
        expect(resolveVHConfig({ aiMaxRetries: -3 }).aiMaxRetries).toBe(0);
    });

    test('clamps non-positive timeouts to 1ms', () => {
        expect(resolveVHConfig({ proposalTimeoutMs: 0 }).proposalTimeoutMs).toBe(1);
        expect(resolveVHConfig({ settlementTimeoutMs: -100 }).settlementTimeoutMs).toBe(1);
    });
});

describe('VHConfig — validateVHConfig rejection', () => {
    test('rejects minWins > maxSteps', () => {
        expect(() => resolveVHConfig({ maxSteps: 3, minWins: 5 })).toThrow(RangeError);
        expect(() => resolveVHConfig({ maxSteps: 3, minWins: 5 })).toThrow(/minWins.*maxSteps/);
    });

    test('rejects non-positive maxSteps', () => {
        const invalid = { ...DEFAULT_VH_CONFIG, maxSteps: 0 };
        expect(() => validateVHConfig(invalid)).toThrow(RangeError);
    });

    test('rejects non-positive minWins', () => {
        const invalid = { ...DEFAULT_VH_CONFIG, minWins: 0 };
        expect(() => validateVHConfig(invalid)).toThrow(RangeError);
    });

    test('rejects virtualStake below Deriv minimum', () => {
        const invalid = { ...DEFAULT_VH_CONFIG, virtualStake: 0.1 };
        expect(() => validateVHConfig(invalid)).toThrow(RangeError);
    });

    test('accepts a full valid config', () => {
        expect(() => validateVHConfig({ ...DEFAULT_VH_CONFIG })).not.toThrow();
    });
});