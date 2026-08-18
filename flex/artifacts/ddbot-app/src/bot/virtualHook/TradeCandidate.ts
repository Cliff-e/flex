// =============================================================
// TradeCandidate — Normalized input model
//
// Every trading engine (XML, AI, Speedbot, future) must submit
// exactly this shape to VirtualHookEngine.start().
//
// There must be NO per-engine variations of this model.
// =============================================================

/**
 * Standardized trade signal submitted to the Virtual Hook engine
 * for pre-execution authorization.
 *
 * This is the ONLY input format accepted by VirtualHookEngine.
 * XML produces it. AI produces it. Future engines produce it.
 * Virtual Hook consumes it.
 */
export interface TradeCandidate {
    /** Unique identifier for this trade signal (UUID). */
    signalId: string;

    /**
     * Which engine produced this candidate.
     * Determines which ProposalAdapter implementation is used.
     */
    source: 'xml' | 'ai' | 'speedbot';

    /**
     * Contract type.
     * Valid values include: DIGITMATCH, DIGITDIFF, DIGITOVER, DIGITUNDER,
     * DIGITEVEN, DIGITODD, CALL, PUT, CALLE, PUTE, ONETOUCH, NOTOUCH,
     * EXPIRYRANGE, EXPIRYMISS, RESETCALL, RESETPUT, RUNHIGH, RUNLOW,
     * CALLSPREAD, PUTSPREAD, ASIANU, ASIAND.
     */
    contractType: string;

    /** Market symbol, e.g. 'R_100', '1HZ100V', 'BOOM300N'. */
    symbol: string;

    /**
     * Stake amount for the REAL trade.
     * NEVER used for virtual contracts — virtual stake is configured
     * separately in VirtualPolicy.
     */
    realStake: number;

    /** Duration for the real contract. */
    duration: number;

    /**
     * Duration unit.
     * 't' = ticks, 's' = seconds, 'm' = minutes, 'h' = hours, 'd' = days.
     */
    durationUnit: 't' | 's' | 'm' | 'h' | 'd';

    /** Currency, e.g. 'USD', 'EUR', 'GBP'. */
    currency: string;

    /** Basis, e.g. 'stake', 'payout'. */
    basis: string;

    /**
     * For digit contracts: the prediction / barrier digit (0–9), or null.
     * When null, SettlementEngine uses default barriers
     * (e.g., 5 for DIGITOVER/UNDER).
     */
    prediction: number | null;

    /**
     * Additional trade parameters needed for proposal construction.
     * May include barrier values, multipliers, barrier2, etc. depending
     * on the contract type.
     */
    tradeParams: Record<string, unknown>;

    /** Timestamp when this candidate was generated (epoch ms). */
    generatedAt: number;
}

/**
 * Type guard — returns true if the value looks like a valid TradeCandidate.
 * This is a lightweight structural check, not an exhaustive validator.
 */
export function isTradeCandidate(value: unknown): value is TradeCandidate {
    if (!value || typeof value !== 'object') return false;
    const c = value as Record<string, unknown>;
    return (
        typeof c.signalId === 'string' &&
        typeof c.source === 'string' &&
        ['xml', 'ai', 'speedbot'].includes(c.source as string) &&
        typeof c.contractType === 'string' &&
        typeof c.symbol === 'string' &&
        typeof c.realStake === 'number' &&
        typeof c.duration === 'number' &&
        typeof c.durationUnit === 'string' &&
        typeof c.currency === 'string' &&
        typeof c.basis === 'string' &&
        typeof c.generatedAt === 'number'
    );
}