// =============================================================
// XmlProposalAdapter — ProposalAdapter backed by api_base
//
// This adapter wraps the existing XML proposal infrastructure
// (api_base.api.send() + tradeOptionToProposal()) so the
// VirtualHookEngine can acquire virtual proposals through the
// same transport used by real trades.
//
// It does NOT own funded purchases — it only acquires pricing
// for virtual contract evaluation.
// =============================================================

import type { ProposalAdapter, ProposalResult, VHProposal } from '../ProposalAdapter';
import type { TradeCandidate } from '../TradeCandidate';
import { getUUID } from '../utils/uuid';

/**
 * Signature of the api_base.api.send() function.
 * Avoids a direct import of bot-skeleton types so the adapter
 * stays loosely coupled to the transport.
 */
type ApiSendFn = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Signature of tradeOptionToProposal from bot-skeleton helpers.
 */
type TradeOptionToProposalFn = (
    tradeOption: Record<string, unknown>,
    purchaseReference: string
) => Array<Record<string, unknown>>;

/**
 * Options passed to the adapter at construction time.
 *
 * The caller (ActiveContract/Purchase) provides live references
 * so the adapter always reads the current tradeOptions, symbol,
 * and prediction state without needing to be reconstructed.
 */
export interface XmlProposalAdapterOptions {
    /** The api_base.api.send function. */
    send: ApiSendFn;

    /** Callback that returns the live tradeOptions object on the engine. */
    getTradeOptions: () => Record<string, unknown> | undefined | null;

    /** Callback that returns the current symbol (respects overrides). */
    getSymbol: () => string;

    /** Callback that returns the current prediction (respects overrides). */
    getPrediction: () => number | null;

    /** Factory for tradeOptionToProposal payloads. */
    tradeOptionToProposal: TradeOptionToProposalFn;
}

/**
 * Proposal adapter wrapping the XML API transport.
 *
 * This adapter is constructed once and reused for the lifetime
 * of the engine. It reads current state via callbacks so it never
 * holds stale references.
 */
export class XmlProposalAdapter implements ProposalAdapter {
    private readonly _send: ApiSendFn;
    private readonly _getTradeOptions: () => Record<string, unknown> | undefined | null;
    private readonly _getSymbol: () => string;
    private readonly _getPrediction: () => number | null;
    private readonly _tradeOptionToProposal: TradeOptionToProposalFn;
    private _aborted = false;

    constructor(options: XmlProposalAdapterOptions) {
        this._send = options.send;
        this._getTradeOptions = options.getTradeOptions;
        this._getSymbol = options.getSymbol;
        this._getPrediction = options.getPrediction;
        this._tradeOptionToProposal = options.tradeOptionToProposal;
    }

    /**
     * Request a virtual proposal for the given candidate and stake.
     *
     * Builds a proposal payload with the same shape as a real
     * proposal (tradeOptionToProposal) but using virtualStake
     * as the amount and a virtual purchase reference for
     * isolation from real proposals.
     */
    async requestProposal(
        candidate: TradeCandidate,
        virtualStake: number,
        timeoutMs: number
    ): Promise<ProposalResult> {
        if (this._aborted) {
            return { ok: false, retryable: false, reason: 'Adapter aborted.' };
        }

        const tradeOptions = this._getTradeOptions();

        if (!tradeOptions || typeof tradeOptions !== 'object') {
            return {
                ok: false,
                retryable: false,
                reason: 'Trade options not available — engine may not be started.',
            };
        }

        // Build a virtual trade option with the same shape as a real one,
        // but using virtualStake for the amount and a VH-specific
        // purchase reference to prevent collision with real proposals.
        const virtualTradeOption = {
            ...(tradeOptions as Record<string, unknown>),
            contractTypes: [candidate.contractType],
            amount: virtualStake,
            symbol: this._getSymbol(),
        };

        // Apply the current prediction if set.
        const prediction = this._getPrediction();
        if (prediction !== null && prediction !== undefined) {
            (virtualTradeOption as Record<string, unknown>).prediction = prediction;
        }

        // Virtual-only purchase reference — guarantees isolation from
        // the real proposal cache.
        const virtualRef = `VH-${getUUID()}`;

        let proposals: Array<Record<string, unknown>>;
        try {
            proposals = this._tradeOptionToProposal(virtualTradeOption, virtualRef);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return {
                ok: false,
                retryable: false,
                reason: `Failed to build proposal payload: ${reason}`,
            };
        }

        if (!proposals || proposals.length === 0) {
            return {
                ok: false,
                retryable: false,
                reason: `No proposal generated for contract type '${candidate.contractType}'.`,
            };
        }

        const proposalPayload = proposals[0];

        // Race the API call against the timeout.
        try {
            const response = await this._raceAgainstTimeout(
                this._send(proposalPayload),
                timeoutMs,
                'Proposal request timed out.'
            );

            const proposalData =
                (response as Record<string, unknown>)?.proposal ??
                (response as Record<string, unknown>)?.data?.proposal;

            if (!proposalData || typeof proposalData !== 'object') {
                return {
                    ok: false,
                    retryable: true,
                    reason: 'Proposal response missing proposal data.',
                    error: response,
                };
            }

            const p = proposalData as Record<string, unknown>;

            if (!p.id || typeof p.id !== 'string') {
                return {
                    ok: false,
                    retryable: true,
                    reason: 'Proposal response missing id.',
                    error: response,
                };
            }

            const vhProposal: VHProposal = {
                id: p.id,
                askPrice: typeof p.ask_price === 'number' ? p.ask_price : Number(p.ask_price ?? 0),
                contractType: candidate.contractType,
                symbol: candidate.symbol,
                raw: proposalData as Record<string, unknown>,
            };

            return { ok: true, proposal: vhProposal };
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            // Timeout errors are retryable; other transport errors are retryable
            // as long as they aren't permanent (e.g. auth failures).
            const isTimeout = reason.includes('timed out');
            const isAuthFailure = reason.includes('401') || reason.includes('Unauthorized') || reason.includes('AuthorizationRequired');
            return {
                ok: false,
                retryable: !isAuthFailure,
                reason,
                error: err,
            };
        }
    }

    /**
     * Abort any in-flight proposal request.
     * The api_base transport layer does not support mid-request
     * cancellation, so this sets a flag that causes future
     * requestProposal() calls to fail fast.
     */
    abort(): void {
        this._aborted = true;
    }

    /**
     * Race a promise against a timeout.
     */
    private _raceAgainstTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
        timeoutMessage: string
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(timeoutMessage));
            }, timeoutMs);

            promise
                .then(result => {
                    clearTimeout(timer);
                    resolve(result);
                })
                .catch(err => {
                    clearTimeout(timer);
                    reject(err);
                });
        });
    }
}