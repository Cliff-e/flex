import { CONTRACT_TYPES } from '@/components/shared';

export const DEFAULT_OPTIONS_PROPOSAL_REQUEST = {
    amount: undefined,
    basis: 'stake',
    contract_type: undefined,
    currency: undefined,
    symbol: undefined,
    duration: undefined,
    duration_unit: undefined,
    proposal: 1,
};

export const requestOptionsProposalForQS = (input_values, ws) => {
    const { amount, currency, symbol, contract_type, duration, duration_unit, basis } = input_values;

    // Guard: reject early if required trading fields are undefined or invalid.
    // These fields come from the Blockly workspace — they may be undefined if the
    // workspace hasn't fully loaded or the trade_definition block is incomplete.
    if (!symbol || symbol === 'undefined' || symbol === 'na') {
        return Promise.reject(new Error(
            `[options-proposal] symbol is not ready: "${symbol}". ` +
            'Ensure the Trade Definition block has a valid market selected.'
        ));
    }
    if (!contract_type || contract_type === 'undefined') {
        return Promise.reject(new Error(
            `[options-proposal] contract_type is not ready: "${contract_type}". ` +
            'Ensure the Trade Type block is connected.'
        ));
    }
    if (!currency || currency === 'undefined') {
        return Promise.reject(new Error(
            `[options-proposal] currency is not ready: "${currency}". ` +
            'User must be logged in with an active account to trade.'
        ));
    }
    if (amount === undefined || amount === null || Number.isNaN(Number(amount))) {
        return Promise.reject(new Error(
            `[options-proposal] amount is not ready: "${amount}".`
        ));
    }
    if (!duration || !duration_unit) {
        return Promise.reject(new Error(
            `[options-proposal] duration is not ready: duration="${duration}", unit="${duration_unit}".`
        ));
    }

    const proposal_request = {
        ...DEFAULT_OPTIONS_PROPOSAL_REQUEST,
        amount,
        currency,
        symbol,
        contract_type,
        duration,
        duration_unit,
        basis,
    };

    // Add barrier value of 5 only for specific digit contract types
    const digit_contracts = [
        CONTRACT_TYPES.MATCH_DIFF.MATCH, // DIGITMATCH
        CONTRACT_TYPES.MATCH_DIFF.DIFF, // DIGITDIFF
        CONTRACT_TYPES.OVER_UNDER.OVER, // DIGITOVER
        CONTRACT_TYPES.OVER_UNDER.UNDER, // DIGITUNDER
    ];

    if (digit_contracts.includes(contract_type)) {
        proposal_request.barrier = 5;
    }

    return ws
        ?.send(proposal_request)
        .then(response => {
            if (response.error) {
                return Promise.reject(response.error);
            }
            return response;
        })
        .catch(error => {
            throw error;
        });
};
