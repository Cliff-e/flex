// =============================================================
// VHConfig — Virtual Hook configuration types
//
// Centralized configuration types shared across the subsystem.
// =============================================================

/**
 * Minimum virtual stake accepted by the engine.
 * Mirrors the Deriv minimum stake (0.35 USD for most symbols).
 */
export const DERIV_MINIMUM_STAKE = 0.35;

/**
 * Configuration for the Virtual Hook engine.
 *
 * This is set once per bot session and read by VirtualPolicy,
 * VirtualHookEngine, and SettlementEngine as needed.
 */
export interface VHConfig {
    /** Enable or disable the Virtual Hook entirely. */
    enabled: boolean;

    /** Maximum number of virtual rounds allowed per signal (min 1). */
    maxSteps: number;

    /** Minimum virtual wins required to authorize the real trade (min 1). */
    minWins: number;

    /** Virtual stake — used only for virtual contracts, never for real trades. */
    virtualStake: number;

    /** Maximum time (ms) to wait for a proposal response. */
    proposalTimeoutMs: number;

    /** Maximum time (ms) to wait for a settlement event. */
    settlementTimeoutMs: number;

    /** Maximum number of retries for failed proposal requests. */
    maxProposalRetries: number;

    /** Maximum number of consecutive failed rounds before giving up. */
    maxConsecutiveFailures: number;

    /**
     * Maximum number of RETRY re-submissions in the AI gate's RETRY loop.
     * Default 3. Only used by the AI trading engine; XML uses its own bound
     * via _vhMaxRetries in Purchase.js.
     */
    aiMaxRetries: number;
}

/**
 * Default configuration. Safe to use if the caller provides no overrides.
 */
export const DEFAULT_VH_CONFIG: VHConfig = {
    enabled: false,
    maxSteps: 5,
    minWins: 3,
    virtualStake: 1.0,
    proposalTimeoutMs: 15_000,
    settlementTimeoutMs: 30_000,
    maxProposalRetries: 3,
    maxConsecutiveFailures: 5,
    aiMaxRetries: 3,
};

/**
 * Validate a complete VHConfig.
 *
 * Throws RangeError when the configuration is impossible —
 * these cannot be safely normalized and must be rejected early:
 *   • minWins > maxSteps (an authorization can never be reached)
 *
 * All other invalid inputs are normalized (clamped) by resolveVHConfig.
 */
export function validateVHConfig(config: VHConfig): void {
    if (!Number.isFinite(config.maxSteps) || config.maxSteps <= 0) {
        throw new RangeError(`VHConfig.maxSteps must be a positive number (got ${config.maxSteps}).`);
    }
    if (!Number.isFinite(config.minWins) || config.minWins <= 0) {
        throw new RangeError(`VHConfig.minWins must be a positive number (got ${config.minWins}).`);
    }
    if (config.minWins > config.maxSteps) {
        throw new RangeError(
            `VHConfig.minWins (${config.minWins}) must not exceed maxSteps (${config.maxSteps}).`
        );
    }
    if (!Number.isFinite(config.virtualStake) || config.virtualStake < DERIV_MINIMUM_STAKE) {
        throw new RangeError(
            `VHConfig.virtualStake must be >= ${DERIV_MINIMUM_STAKE} (got ${config.virtualStake}).`
        );
    }
    if (!Number.isFinite(config.proposalTimeoutMs) || config.proposalTimeoutMs <= 0) {
        throw new RangeError(
            `VHConfig.proposalTimeoutMs must be a positive number (got ${config.proposalTimeoutMs}).`
        );
    }
    if (!Number.isFinite(config.settlementTimeoutMs) || config.settlementTimeoutMs <= 0) {
        throw new RangeError(
            `VHConfig.settlementTimeoutMs must be a positive number (got ${config.settlementTimeoutMs}).`
        );
    }
    if (!Number.isFinite(config.maxProposalRetries) || config.maxProposalRetries < 0) {
        throw new RangeError(
            `VHConfig.maxProposalRetries must be >= 0 (got ${config.maxProposalRetries}).`
        );
    }
    if (!Number.isFinite(config.maxConsecutiveFailures) || config.maxConsecutiveFailures < 0) {
        throw new RangeError(
            `VHConfig.maxConsecutiveFailures must be >= 0 (got ${config.maxConsecutiveFailures}).`
        );
    }
    if (!Number.isFinite(config.aiMaxRetries) || config.aiMaxRetries < 0) {
        throw new RangeError(
            `VHConfig.aiMaxRetries must be >= 0 (got ${config.aiMaxRetries}).`
        );
    }
}

/**
 * Merges a partial configuration with the defaults.
 *
 * Values are normalized to valid ranges (clamped) so callers can never
 * construct an engine with broken timeouts / negative retry counts.
 * Impossible combinations (minWins > maxSteps) throw RangeError so the
 * caller is rejected early rather than failing mid-run.
 *
 * Always produces a complete, valid VHConfig object.
 */
export function resolveVHConfig(overrides?: Partial<VHConfig>): VHConfig {
    const merged: VHConfig = { ...DEFAULT_VH_CONFIG, ...overrides };

    // Normalize integer fields (clamp to valid ranges).
    merged.maxSteps = Math.max(1, Math.floor(Number(merged.maxSteps)) || 1);
    merged.minWins = Math.max(1, Math.floor(Number(merged.minWins)) || 1);
    merged.virtualStake = Math.max(
        DERIV_MINIMUM_STAKE,
        Number(merged.virtualStake) || DERIV_MINIMUM_STAKE
    );
    merged.proposalTimeoutMs = Math.max(1, Number(merged.proposalTimeoutMs) || 1);
    merged.settlementTimeoutMs = Math.max(1, Number(merged.settlementTimeoutMs) || 1);
    merged.maxProposalRetries = Math.max(0, Math.floor(Number(merged.maxProposalRetries)) || 0);
    merged.maxConsecutiveFailures = Math.max(
        0,
        Math.floor(Number(merged.maxConsecutiveFailures)) || 0
    );
    merged.aiMaxRetries = Math.max(0, Math.floor(Number(merged.aiMaxRetries)) || 0);

    // Reject impossible explicit configurations only.
    // An explicit minWins that exceeds maxSteps is a caller bug — reject early.
    const minWinsExplicit =
        overrides?.minWins !== undefined && overrides?.minWins !== null;
    if (minWinsExplicit && merged.minWins > merged.maxSteps) {
        throw new RangeError(
            `VHConfig.minWins (${merged.minWins}) must not exceed maxSteps (${merged.maxSteps}).`
        );
    }

    // Implicit combinations self-heal: if the default minWins (or a clamped
    // maxSteps) would produce minWins > maxSteps, clamp minWins down so the
    // config remains valid. Example: resolveVHConfig({ maxSteps: 0 }) →
    // maxSteps 1, minWins 1 (not an error).
    merged.minWins = Math.min(merged.minWins, merged.maxSteps);

    validateVHConfig(merged);

    return merged;
}
