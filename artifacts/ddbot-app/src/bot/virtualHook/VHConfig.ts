// =============================================================
// VHConfig — Virtual Hook configuration types
//
// Centralized configuration types shared across the subsystem.
// =============================================================

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
 * Merges a partial configuration with the defaults.
 * Always produces a complete VHConfig object.
 */
export function resolveVHConfig(overrides?: Partial<VHConfig>): VHConfig {
    return { ...DEFAULT_VH_CONFIG, ...overrides };
}