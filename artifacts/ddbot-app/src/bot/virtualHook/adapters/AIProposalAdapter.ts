// =============================================================
// AIProposalAdapter — ProposalAdapter backed by WebSocketManager
//
// This adapter wraps the existing AI trading transport
// (WebSocketManager.send() + EventBus) so the VirtualHookEngine
// can acquire virtual proposals through the same shared WS used
// for real trades.
//
// It does NOT own funded purchases — it only acquires pricing
// for virtual contract evaluation.
// =============================================================

import type { ProposalAdapter, ProposalResult, VHProposal } from '../ProposalAdapter';
import type { TradeCandidate } from '../TradeCandidate';
import { getUUID } from '../utils/uuid';

/**
 * Signature of WebSocketManager.send().
 * Avoids a direct import so the adapter stays loosely coupled.
 */
type WsSendFn = (payload: Record<string, unknown>) => void;

/**
 * Signature of EventBus.on() subscription.
 * Returns an unsubscribe function.
 */
type EventBusOnFn = (
    event: string,
    callback: (msg: Record<string, unknown>) => void
) => () => void;

/**
 * Options passed to the adapter at construction time.
 *
 * The caller (TradingEngine) provides live references to the
 * shared WS transport and the current symbol/config.
 */
export interface AIProposalAdapterOptions {
    /** The WebSocketManager.send function. */
    send: WsSendFn;

    /** EventBus.on subscription function for proposal responses. */
    onProposalResponse: EventBusOnFn;

    /** Callback that returns the current symbol. */
    getSymbol: () => string;
}

/**
 * Proposal adapter wrapping the AI WebSocket transport.
 *
 * This adapter satisfies the ProposalAdapter interface exactly
 * as XmlProposalAdapter does — the VirtualHookEngine treats them
 * identically. The only difference is the transport layer:
 *   • XML → api_base.api.send() (HTTP)
 *   • AI  → WebSocketManager.send() + EventBus (shared WS)
 */
export class AIProposalAdapter implements ProposalAdapter {
    private readonly _send: WsSendFn;
    private readonly _onProposalResponse: EventBusOnFn;
    private readonly _getSymbol: () => string;
    private _aborted = false;

    constructor(options: AIProposalAdapterOptions) {
        this._send = options.send;
        this._onProposalResponse = options.onProposalResponse;
        this._getSymbol = options.getSymbol;
    }

    /**
     * Request a virtual proposal for the given candidate and stake.
     *
     * Builds the same proposal payload shape used by _executeTrade()
     * but with virtualStake as the amount.
     */
    async requestProposal(
        candidate: TradeCandidate,
        virtualStake: number,
        timeoutMs: number
    ): Promise<ProposalResult> {
        if (this._aborted) {
            return { ok: false, retryable: false, reason: 'Adapter aborted.' };
        }

        const symbol = this._getSymbol() || candidate.symbol;
        const requestId = `VH-AI-${getUUID()}`;

        const proposalPayload: Record<string, unknown> = {
            proposal: 1,
            amount: String(virtualStake > 0 ? virtualStake : 1),
            basis: candidate.basis || 'stake',
            contract_type: candidate.contractType,
            currency: candidate.currency || 'USD',
            duration: candidate.duration || 1,
            duration_unit: candidate.durationUnit || 't',
            underlying_symbol: symbol,
            passthrough: { vh_request_id: requestId },
        };

        // Add barrier if present in tradeParams
        if (candidate.tradeParams?.barrier != null) {
            (proposalPayload as Record<string, unknown>).barrier = String(candidate.tradeParams.barrier);
        }

        // Add prediction if present
        if (candidate.prediction != null) {
            (proposalPayload as Record<string, unknown>).prediction = candidate.prediction;
        }

        return new Promise<ProposalResult>(resolve => {
            let resolved = false;

            const timer = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                unsub();
                resolve({
                    ok: false,
                    retryable: true,
                    reason: `Proposal request timed out after ${timeoutMs}ms.`,
                });
            }, timeoutMs);

            const unsub = this._onProposalResponse('proposal', (msg: Record<string, unknown>) => {
                if (resolved) return;

                // Match on vh_request_id via passthrough echo (if available)
                const echo = msg as Record<string, unknown>;
                const pt = echo?.passthrough as Record<string, unknown> | undefined;
                const vhMatch = pt?.vh_request_id === requestId;

                // If passthrough echo not available, accept the first proposal
                // response that looks valid (the VH engine serialises requests
                // via its busy flag, so there is never contention).
                const hasProposal =
                    (echo?.proposal as Record<string, unknown>)?.id != null;

                if (!vhMatch && !hasProposal) return;

                // Prefer exact match, but fall back to first valid proposal.
                if (!vhMatch && hasProposal) {
                    // Accept first valid proposal since there can only be one
                    // in-flight VH proposal per engine instance.
                }

                if (echo?.error) {
                    const errorObj = echo.error as Record<string, unknown>;
                    const errorCode = String(errorObj?.code ?? '');
                    const errorMessage = String(errorObj?.message ?? 'API error');
                    const isAuthFailure =
                        errorCode === 'AuthorizationRequired' ||
                        errorMessage.includes('401') ||
                        errorMessage.includes('Unauthorized');

                    resolved = true;
                    clearTimeout(timer);
                    unsub();
                    resolve({
                        ok: false,
                        retryable: !isAuthFailure,
                        reason: errorMessage,
                        error: echo.error,
                    });
                    return;
                }

                const proposalData =
                    echo?.proposal as Record<string, unknown> | undefined;

                if (!proposalData || typeof proposalData !== 'object') {
                    return; // not our response — keep waiting
                }

                const p = proposalData as Record<string, unknown>;

                if (!p.id || typeof p.id !== 'string') {
                    resolved = true;
                    clearTimeout(timer);
                    unsub();
                    resolve({
                        ok: false,
                        retryable: true,
                        reason: 'Proposal response missing id.',
                        error: echo,
                    });
                    return;
                }

                const vhProposal: VHProposal = {
                    id: p.id,
                    askPrice: typeof p.ask_price === 'number' ? p.ask_price : Number(p.ask_price ?? 0),
                    contractType: candidate.contractType,
                    symbol,
                    raw: proposalData as Record<string, unknown>,
                };

                resolved = true;
                clearTimeout(timer);
                unsub();
                resolve({ ok: true, proposal: vhProposal });
            });

            try {
                this._send(proposalPayload);
            } catch (err) {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                unsub();
                const reason = err instanceof Error ? err.message : String(err);
                resolve({
                    ok: false,
                    retryable: true,
                    reason: `WS send failed: ${reason}`,
                    error: err,
                });
            }
        });
    }

    /**
     * Abort any in-flight proposal request.
     * Sets a flag that causes future requestProposal() calls to fail fast.
     */
    abort(): void {
        this._aborted = true;
    }
}