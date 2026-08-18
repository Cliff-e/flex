// =============================================================
// SettlementEngine Tests
// =============================================================

import {
    isDigitContractWin,
    settleDigitContract,
    isDigitContract,
} from '../SettlementEngine';

import type { TradeCandidate } from '../TradeCandidate';

function makeCandidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
    return {
        signalId: 'test-signal-1',
        source: 'xml',
        contractType: 'DIGITOVER',
        symbol: 'R_100',
        realStake: 10,
        duration: 1,
        durationUnit: 't',
        currency: 'USD',
        basis: 'stake',
        prediction: null,
        tradeParams: {},
        generatedAt: Date.now(),
        ...overrides,
    };
}

describe('SettlementEngine.isDigitContractWin', () => {
    test('DIGITOVER with default barrier (> 4)', () => {
        expect(isDigitContractWin('DIGITOVER', 5)).toBe(true);
        expect(isDigitContractWin('DIGITOVER', 4)).toBe(false);
        expect(isDigitContractWin('DIGITOVER', 9)).toBe(true);
        expect(isDigitContractWin('DIGITOVER', 0)).toBe(false);
    });

    test('DIGITOVER with explicit prediction', () => {
        expect(isDigitContractWin('DIGITOVER', 7, 5)).toBe(true);
        expect(isDigitContractWin('DIGITOVER', 5, 5)).toBe(false);
        expect(isDigitContractWin('DIGITOVER', 4, 5)).toBe(false);
    });

    test('DIGITUNDER with default barrier (< 5)', () => {
        expect(isDigitContractWin('DIGITUNDER', 4)).toBe(true);
        expect(isDigitContractWin('DIGITUNDER', 5)).toBe(false);
        expect(isDigitContractWin('DIGITUNDER', 0)).toBe(true);
        expect(isDigitContractWin('DIGITUNDER', 9)).toBe(false);
    });

    test('DIGITUNDER with explicit prediction', () => {
        expect(isDigitContractWin('DIGITUNDER', 4, 5)).toBe(true);
        expect(isDigitContractWin('DIGITUNDER', 5, 5)).toBe(false);
    });

    test('DIGITMATCH requires exact prediction match', () => {
        expect(isDigitContractWin('DIGITMATCH', 5, 5)).toBe(true);
        expect(isDigitContractWin('DIGITMATCH', 6, 5)).toBe(false);
        expect(isDigitContractWin('DIGITMATCH', 0, 0)).toBe(true);
        // No prediction → always false
        expect(isDigitContractWin('DIGITMATCH', 5, null)).toBe(false);
    });

    test('DIGITDIFF requires difference from prediction', () => {
        expect(isDigitContractWin('DIGITDIFF', 6, 5)).toBe(true);
        expect(isDigitContractWin('DIGITDIFF', 5, 5)).toBe(false);
        // No prediction → default barrier 5
        expect(isDigitContractWin('DIGITDIFF', 4, null)).toBe(true);
        expect(isDigitContractWin('DIGITDIFF', 5, null)).toBe(false);
    });

    test('DIGITEVEN — even digits win', () => {
        expect(isDigitContractWin('DIGITEVEN', 0)).toBe(true);
        expect(isDigitContractWin('DIGITEVEN', 2)).toBe(true);
        expect(isDigitContractWin('DIGITEVEN', 8)).toBe(true);
        expect(isDigitContractWin('DIGITEVEN', 1)).toBe(false);
        expect(isDigitContractWin('DIGITEVEN', 9)).toBe(false);
    });

    test('DIGITODD — odd digits win', () => {
        expect(isDigitContractWin('DIGITODD', 1)).toBe(true);
        expect(isDigitContractWin('DIGITODD', 9)).toBe(true);
        expect(isDigitContractWin('DIGITODD', 0)).toBe(false);
        expect(isDigitContractWin('DIGITODD', 8)).toBe(false);
    });

    test('CALL / CALLE — high digits win', () => {
        expect(isDigitContractWin('CALL', 5)).toBe(true);
        expect(isDigitContractWin('CALL', 9)).toBe(true);
        expect(isDigitContractWin('CALL', 4)).toBe(false);
        expect(isDigitContractWin('CALLE', 6)).toBe(true);
        expect(isDigitContractWin('CALLE', 3)).toBe(false);
    });

    test('PUT / PUTE — low digits win', () => {
        expect(isDigitContractWin('PUT', 4)).toBe(true);
        expect(isDigitContractWin('PUT', 0)).toBe(true);
        expect(isDigitContractWin('PUT', 5)).toBe(false);
        expect(isDigitContractWin('PUTE', 3)).toBe(true);
        expect(isDigitContractWin('PUTE', 7)).toBe(false);
    });

    test('Unknown contract types fall back to even-digit heuristic', () => {
        expect(isDigitContractWin('UNKNOWN_TYPE', 2)).toBe(true);
        expect(isDigitContractWin('UNKNOWN_TYPE', 3)).toBe(false);
    });
});

describe('SettlementEngine.settleDigitContract', () => {
    test('Returns correct settlement for DIGITOVER with prediction', () => {
        const candidate = makeCandidate({ contractType: 'DIGITOVER', prediction: 5 });
        const result = settleDigitContract(candidate, 7);
        expect(result.won).toBe(true);
        expect(result.exitDigit).toBe(7);
        expect(result.contractType).toBe('DIGITOVER');
        expect(result.prediction).toBe(5);
    });

    test('Returns correct settlement for DIGITEVEN', () => {
        const candidate = makeCandidate({ contractType: 'DIGITEVEN' });
        const result = settleDigitContract(candidate, 8);
        expect(result.won).toBe(true);
    });
});

describe('SettlementEngine.isDigitContract', () => {
    test('Known digit contracts return true', () => {
        expect(isDigitContract('DIGITMATCH')).toBe(true);
        expect(isDigitContract('DIGITDIFF')).toBe(true);
        expect(isDigitContract('DIGITOVER')).toBe(true);
        expect(isDigitContract('DIGITUNDER')).toBe(true);
        expect(isDigitContract('DIGITEVEN')).toBe(true);
        expect(isDigitContract('DIGITODD')).toBe(true);
        expect(isDigitContract('CALL')).toBe(true);
        expect(isDigitContract('PUT')).toBe(true);
    });

    test('Non-digit contracts return false', () => {
        expect(isDigitContract('ACCU')).toBe(false);
        expect(isDigitContract('TURBOS')).toBe(false);
        expect(isDigitContract('MULTIPLIER')).toBe(false);
        expect(isDigitContract('')).toBe(false);
    });
});