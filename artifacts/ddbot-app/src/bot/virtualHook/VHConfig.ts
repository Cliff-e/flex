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

    /** Maximum consecutive virtual wins before the next real trade. */
    winThreshold: number;

    /** Whether the consecutive-win authorization condition is enabled. */
    winThresholdEnabled: boolean;

    /** Maximum consecutive virtual losses before the next real trade. */
    lossThreshold: number;

    /** Whether the consecutive-loss authorization condition is enabled. */
    lossThresholdEnabled: boolean;

    /** Maximum completed virtual contracts in the current VH session. */
    maxSteps: number;

    /** Whether the completed-instance authorization condition is enabled. */
    maxStepsEnabled: boolean;

    /**
     * @deprecated Use winThreshold. Accepted only so older callers can be
     * migrated without breaking at the configuration boundary.
     */
    minWins?: number;

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
    winThreshold: 3,
    winThresholdEnabled: true,
    lossThreshold: 3,
    lossThresholdEnabled: false,
    maxSteps: 5,
    maxStepsEnabled: true,
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
 * Threshold values are allowed to be zero. Zero means that condition is
 * disabled, regardless of its explicit enable flag.
 */
export function validateVHConfig(config: VHConfig): void {
    if (!Number.isFinite(config.winThreshold) || config.winThreshold < 0) {
        throw new RangeError(`VHConfig.winThreshold must be >= 0 (got ${config.winThreshold}).`);
    }
    if (!Number.isFinite(config.lossThreshold) || config.lossThreshold < 0) {
        throw new RangeError(`VHConfig.lossThreshold must be >= 0 (got ${config.lossThreshold}).`);
    }
    if (!Number.isFinite(config.maxSteps) || config.maxSteps < 0) {
        throw new RangeError(`VHConfig.maxSteps must be >= 0 (got ${config.maxSteps}).`);
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
 * Always produces a complete, valid VHConfig object.
 */
export function resolveVHConfig(overrides?: Partial<VHConfig>): VHConfig {
    const legacyWinThreshold =
        overrides?.winThreshold === undefined && overrides?.minWins !== undefined
            ? overrides.minWins
            : undefined;
    const merged: VHConfig = {
        ...DEFAULT_VH_CONFIG,
        ...overrides,
        ...(legacyWinThreshold !== undefined ? { winThreshold: legacyWinThreshold } : {}),
    };

    // Normalize integer fields. Authorization thresholds intentionally allow 0.
    merged.winThreshold = Math.max(0, Math.floor(Number(merged.winThreshold)) || 0);
    merged.lossThreshold = Math.max(0, Math.floor(Number(merged.lossThreshold)) || 0);
    merged.maxSteps = Math.max(0, Math.floor(Number(merged.maxSteps)) || 0);
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

    validateVHConfig(merged);

    return merged;
}
