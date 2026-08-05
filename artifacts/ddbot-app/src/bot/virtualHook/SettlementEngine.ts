// =============================================================
// SettlementEngine — Canonical settlement logic
//
// This is the SINGLE source of truth for determining whether a
// virtual contract won or lost. Every trading engine's virtual
// hook evaluation must use this engine. No duplicate settlement
// logic exists anywhere else.
// =============================================================

import type { TradeCandidate } from './TradeCandidate';

/**
 * Contract types that are evaluated based on digit outcomes.
 * All other types are currently unsupported by the settlement
 * engine.
 */
export const DIGIT_CONTRACT_TYPES = new Set<string>([
    'DIGITMATCH',
    'DIGITDIFF',
    'DIGITOVER',
    'DIGITUNDER',
    'DIGITEVEN',
    'DIGITODD',
    'CALL',
    'PUT',
    'CALLE',
    'PUTE',
]);

/**
 * Sentinel value used when a prediction was not provided.
 */
const NO_PREDICTION = null;

/**
 * Canonical settlement evaluation for digit-based contracts.
 *
 * Pure function — no side effects, no I/O, no state.
 *
 * @param contractType - Deriv contract type (e.g. 'DIGITOVER').
 * @param lastDigit    - The last digit (0–9) of the exit tick.
 * @param prediction   - The prediction digit (0–9), or null for default barriers.
 * @returns true if the virtual contract would have won.
 */
export function isDigitContractWin(
    contractType: string,
    lastDigit: number,
    prediction: number | null = NO_PREDICTION
): boolean {
    const digit = Number(lastDigit);
    const pred = prediction !== null && prediction !== undefined ? Number(prediction) : NO_PREDICTION;

    switch (contractType) {
        case 'DIGITOVER':
            // Win if last digit is strictly greater than the barrier.
            return pred !== NO_PREDICTION ? digit > pred : digit > 4;
        case 'DIGITUNDER':
            // Win if last digit is strictly less than the barrier.
            return pred !== NO_PREDICTION ? digit < pred : digit < 5;
        case 'DIGITMATCH':
            // Win if last digit exactly equals the prediction.
            return pred !== NO_PREDICTION ? digit === pred : false;
        case 'DIGITDIFF':
            // Win if last digit differs from the prediction.
            return pred !== NO_PREDICTION ? digit !== pred : digit !== 5;
        case 'DIGITEVEN':
            return digit % 2 === 0;
        case 'DIGITODD':
            return digit % 2 !== 0;
        case 'CALL':
        case 'CALLE':
            // Simplified proxy for upward movement correlated with higher digits.
            return digit > 4;
        case 'PUT':
        case 'PUTE':
            return digit <= 4;
        default:
            // Unknown contract types drop to a fallback so the hook never
            // crashes — but they must be logged by the caller.
            return digit % 2 === 0;
    }
}

/**
 * Settlement result of a digit contract evaluation.
 */
export interface SettlementResult {
    won: boolean;
    exitDigit: number;
    contractType: string;
    prediction: number | null;
}

/**
 * Evaluate a digit contract settlement from a candidate and exit digit.
 *
 * @param candidate - The TradeCandidate that produced the contract.
 * @param exitDigit - The last digit (0–9) observed at settlement time.
 * @returns SettlementResult describing the outcome.
 */
export function settleDigitContract(candidate: TradeCandidate, exitDigit: number): SettlementResult {
    const won = isDigitContractWin(candidate.contractType, exitDigit, candidate.prediction);
    return {
        won,
        exitDigit,
        contractType: candidate.contractType,
        prediction: candidate.prediction,
    };
}

/**
 * Returns true if the given contract type is a digit contract
 * supported by this settlement engine.
 */
export function isDigitContract(contractType: string): boolean {
    return DIGIT_CONTRACT_TYPES.has(contractType);
}