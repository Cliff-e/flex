// =============================================================
// VirtualContract — Platform contract data model
//
// This is NOT a Deriv contract.
// It is a platform-level contract that reconstructs the complete
// lifecycle of one virtual hook evaluation round.
//
// A new instance is created for each virtual round. It is immutable
// after creation (fields are set progressively and frozen once
// settled).
// =============================================================

import type { TradeCandidate } from './TradeCandidate';

/**
 * Status of a virtual contract through its lifecycle.
 */
export type VirtualContractStatus =
    | 'PENDING_PROPOSAL'
    | 'PROPOSAL_RECEIVED'
    | 'PENDING_BUY'
    | 'ACTIVE'
    | 'WAITING_SETTLEMENT'
    | 'SETTLED'
    | 'TIMED_OUT'
    | 'ERROR';

/**
 * How the settlement result was determined.
 */
export type SettlementSource = 'api' | 'timeout' | 'error';

/**
 * Settlement result of a virtual contract.
 */
export interface VirtualSettlement {
    /** Whether the virtual contract was a win. */
    won: boolean;

    /** How the result was determined. */
    source: SettlementSource;

    /** Raw settlement data from the API (if available). */
    rawContract: Record<string, unknown> | null;

    /** Timestamp when settlement was recorded (epoch ms). */
    settledAt: number;
}

/**
 * A complete record of one virtual hook round.
 *
 * Contains enough information to reconstruct the full lifecycle:
 * identifiers, timestamps, proposal information, duration, entry,
 * exit, settlement, and status.
 */
export interface VirtualContract {
    /** Unique identifier for this virtual contract. Prefix: 'VH-{uuid}'. */
    contractId: string;

    /** The run this contract belongs to. */
    runId: string;

    /** Index of this round within the run (0, 1, 2, ...). */
    roundIndex: number;

    /** The trade candidate this contract is evaluating. */
    candidate: TradeCandidate;

    /** Proposal ID from the Deriv API. */
    proposalId: string;

    /** Ask price from the proposal. */
    askPrice: number;

    /** Virtual stake used (from VH policy, NEVER the real stake). */
    virtualStake: number;

    /** Deriv contract ID (from the buy response), or null if not bought. */
    derivContractId: string | null;

    /** Timestamp when this virtual contract was constructed (epoch ms). */
    createdAt: number;

    /** Timestamp when the contract received its first tick. */
    entryAt: number | null;

    /** The entry tick quote value. */
    entryTick: number | null;

    /** The last digit of the entry tick. */
    entryDigit: number | null;

    /** Timestamp when the contract settled. */
    settledAt: number | null;

    /** The exit tick quote value. */
    exitTick: number | null;

    /** The last digit of the exit tick. */
    exitDigit: number | null;

    /** Settlement result, or null until settled. */
    settlement: VirtualSettlement | null;

    /** Current status in the contract lifecycle. */
    status: VirtualContractStatus;

    /** Duration of this contract in ms (derived from the candidate). */
    durationMs: number;

    /** Timeout timestamp: createdAt + durationMs + settlement margin. */
    timeoutAt: number;
}

/**
 * Factory used by the engine to construct a VirtualContract.
 * Encapsulates UUID generation and duration computation so the
 * engine does not duplicate lifecycle math.
 */
export class VirtualContractFactory {
    /**
     * Create a new virtual contract for a given round.
     *
     * @param runId      - Identifies the run (one TradeCandidate).
     * @param roundIndex - 0-based round index within the run.
     * @param candidate  - The normalized TradeCandidate.
     * @param proposalId - Proposal ID returned by the proposal adapter.
     * @param askPrice   - Ask price from the proposal.
     * @param virtualStake - Virtual stake from VH policy.
     * @returns A fully-constructed VirtualContract.
     */
    static create(
        runId: string,
        roundIndex: number,
        candidate: TradeCandidate,
        proposalId: string,
        askPrice: number,
        virtualStake: number
    ): VirtualContract {
        const contractId = `VH-${cryptoUUID()}`;
        const durationMs = estimateDurationMs(candidate.duration, candidate.durationUnit);
        const now = Date.now();

        return {
            contractId,
            runId,
            roundIndex,
            candidate,
            proposalId,
            askPrice,
            virtualStake,
            derivContractId: null,
            createdAt: now,
            entryAt: null,
            entryTick: null,
            entryDigit: null,
            settledAt: null,
            exitTick: null,
            exitDigit: null,
            settlement: null,
            status: 'PROPOSAL_RECEIVED',
            durationMs,
            timeoutAt: now + durationMs,
        };
    }

    /**
     * Mark the contract as having been bought via the API.
     */
    static markBought(contract: VirtualContract, derivContractId: string): VirtualContract {
        const timeoutAt = Date.now() + contract.durationMs;
        return {
            ...contract,
            derivContractId,
            status: 'ACTIVE',
            timeoutAt,
        };
    }

    /**
     * Record the entry tick.
     */
    static recordEntry(contract: VirtualContract, tick: number): VirtualContract {
        const digit = extractDigitValue(tick);
        return {
            ...contract,
            entryAt: Date.now(),
            entryTick: tick,
            entryDigit: digit,
            status: 'WAITING_SETTLEMENT',
        };
    }

    /**
     * Record settlement for the contract.
     */
    static settle(
        contract: VirtualContract,
        settlement: VirtualSettlement,
        exitTick: number | null
    ): VirtualContract {
        let status: VirtualContractStatus = 'SETTLED';
        if (settlement.source === 'timeout') status = 'TIMED_OUT';
        if (settlement.source === 'error') status = 'ERROR';
        return {
            ...contract,
            settledAt: settlement.settledAt,
            exitTick,
            exitDigit: exitTick !== null ? extractDigitValue(exitTick) : null,
            settlement,
            status,
        };
    }

    /**
     * Mark the contract as errored.
     */
    static markError(contract: VirtualContract, error?: Error): VirtualContract {
        return {
            ...contract,
            settlement: {
                won: false,
                source: 'error',
                rawContract: error ? { message: error.message } : null,
                settledAt: Date.now(),
            },
            status: 'ERROR',
        };
    }
}

/**
 * Fallback UUID generator that works in node/browser environments
 * where crypto.randomUUID may not exist (older browsers).
 */
function cryptoUUID(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback — random hex string.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Estimate the duration of a contract in milliseconds based on the
 * duration unit. This is used for settlement timeouts.
 *
 * 't' (ticks) is treated conservatively at 1s per tick (volatility
 * indices tick at a minimum of ~1s).
 */
export function estimateDurationMs(duration: number, unit: 't' | 's' | 'm' | 'h' | 'd'): number {
    const n = Math.max(1, Number(duration) || 1);
    switch (unit) {
        case 't': return n * 1_000;
        case 's': return n * 1_000;
        case 'm': return n * 60_000;
        case 'h': return n * 3_600_000;
        case 'd': return n * 86_400_000;
        default: return n * 60_000;
    }
}

/**
 * Extract the last digit (0–9) from a raw tick value.
 * Reuses the same canonical logic as sharedExitDigitHistory.extractLastDigit.
 */
export function extractDigitValue(raw: string | number): number {
    return Number(String(raw).replace('.', '').slice(-1));
}