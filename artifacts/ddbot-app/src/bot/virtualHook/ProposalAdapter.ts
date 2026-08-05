// =============================================================
// ProposalAdapter — Proposal acquisition abstraction
//
// Virtual Hook requests proposals through this interface.
// It must NOT own funded purchases — it only acquires pricing.
//
// XML integration will provide an implementation backed by
// api_base (bot-skeleton). AI integration will provide an
// implementation backed by WebSocketManager. Both must satisfy
// this same interface.
// =============================================================

import type { TradeCandidate } from './TradeCandidate';

/**
 * A proposal returned by the Deriv API.
 * Shape is normalized — adapters translate API-specific responses.
 */
export interface VHProposal {
    /** Proposal ID from the Deriv API (required for buy). */
    id: string;

    /** Ask price from the proposal. */
    askPrice: number;

    /** Contract type the proposal is for. */
    contractType: string;

    /** Underlying symbol. */
    symbol: string;

    /** Raw proposal data from the adapter (for audit/debug). */
    raw?: Record<string, unknown>;
}

/**
 * Result of a proposal acquisition attempt.
 * Distinguishes success, transient failure (retryable), and
 * terminal failure (not retryable).
 */
export type ProposalResult =
    | { ok: true; proposal: VHProposal }
    | { ok: false; retryable: boolean; reason: string; error?: unknown };

/**
 * Contract every proposal adapter must implement.
 *
 * Implementations are responsible for:
 *   - Constructing the correct Deriv proposal request payload
 *     for the given candidate and virtual stake.
 *   - Sending the request through their backing transport
 *     (api_base or WebSocketManager).
 *   - Enforcing the timeout and returning retryable vs terminal
 *     failure classification.
 */
export interface ProposalAdapter {
    /**
     * Request a virtual proposal for the given candidate and stake.
     *
     * @param candidate    - The normalized TradeCandidate.
     * @param virtualStake - The virtual stake (from VH policy).
     * @param timeoutMs    - Maximum time to wait for a response.
     * @returns ProposalResult — ok:true on success, ok:false on failure.
     */
    requestProposal(candidate: TradeCandidate, virtualStake: number, timeoutMs: number): Promise<ProposalResult>;

    /**
     * Abort any in-flight proposal request. Called when the engine
     * cancels or times out a run.
     */
    abort(): void;
}