import { observer as globalObserver } from '../../../utils/observer';
import { createDetails } from '../utils/helpers';

const getBotInterface = tradeEngine => {
    const getDetail = i => createDetails(tradeEngine.data.contract)[i];

    return {
        init: (...args) => tradeEngine.init(...args),
        start: (...args) => tradeEngine.start(...args),
        stop: (...args) => tradeEngine.stop(...args),
        purchase: contract_type => tradeEngine.purchase(contract_type),
        /**
         * Execute a hedge trade — automatically purchases the opposite contract
         * of whatever is currently selected (via Trade Definition or active
         * contract override).
         *
         * Delegates entirely to the existing purchase pipeline:
         *   VirtualHook, ActiveContractOverride, SymbolOverride, PredictionOverride,
         *   proposal regeneration, recovery, and open-contract monitoring all apply
         *   exactly as they do for Bot.purchase().
         *
         * Opposite contract mapping (both directions):
         *   Rise (CALL) ↔ Fall (PUT)   •   Rise Equals (CALLE) ↔ Fall Equals (PUTE)
         *   Touch ↔ No Touch           •   Ends Between ↔ Ends Outside
         *   Matches ↔ Differs          •   Even ↔ Odd
         *   Over ↔ Under               •   Reset Call ↔ Reset Put
         *   Only Ups ↔ Only Downs      •   Call Spread ↔ Put Spread
         */
        hedge: () => tradeEngine.hedge(),
        /**
         * Switch the active contract type for every subsequent proposal and
         * purchase.  Pass 'DISABLE' to revert to Trade Parameters.
         * Called by the Contract Type Switcher Blockly block.
         * Does not place a trade immediately.
         */
        setActiveContract: contract_type => tradeEngine.setActiveContractOverride(contract_type),
        /**
         * Switch the active market symbol for every subsequent proposal.
         * Pass 'DISABLE' to revert to Trade Parameters.
         * Called by the Symbol Changer Blockly block.
         * Does not place a trade immediately.
         */
        setActiveSymbol: symbol => tradeEngine.setActiveSymbolOverride(symbol),
        /**
         * Set the digit prediction (0–9) for prediction-based contracts
         * (Matches, Differs, Over, Under).  Pass -1 to revert to Trade
         * Parameters.  Called by the Custom Prediction Blockly block.
         *
         * @param {number} prediction  0–9 or -1 to clear.
         */
        setActivePrediction: prediction => tradeEngine.setActivePredictionOverride(prediction),
        /**
         * Enable or disable the Virtual Hook engine.
         * When enabled the bot runs simulated trades before placing real ones.
         * Called by the Virtual Hook Toggle Blockly block.
         *
         * @param {boolean} enabled
         */
        /**
         * Set the current execution mode string (e.g. 'NORMAL', 'RECOVERY', 'WAIT').
         * Called by the Set Mode Blockly block.
         * @param {string} mode
         */
        setMode: mode => tradeEngine.setMode(mode),
        /**
         * Get the current execution mode string.
         * Called by the Get Mode / If Mode Equals Blockly blocks.
         * @returns {string}
         */
        getMode: () => tradeEngine.getMode(),
        /**
         * Purchase the currently effective contract type, respecting any active
         * contract override. Equivalent to Bot.purchase(currentType) but without
         * requiring the caller to know the active type.
         * Called by the Purchase Current Contract Blockly block.
         */
        purchaseCurrentContract: () => tradeEngine.purchaseCurrentContract(),
        /**
         * Pick a random digit between min and max (inclusive) and set it as the
         * active prediction override.
         * Called by the Random Prediction Blockly block.
         * @param {number} min
         * @param {number} max
         */
        setRandomPrediction: (min, max) => tradeEngine.setRandomPrediction(min, max),
        /**
         * Pick a random symbol from the given group and set it as the active
         * symbol override.
         * Called by the Random Symbol Blockly block.
         * @param {string} group  e.g. 'volatility' | 'volatility_1s' | 'boom_crash' | 'jump'
         */
        setRandomSymbol: group => tradeEngine.setRandomSymbol(group),
        /**
         * Rotate to the next symbol in the given group and set it as the active
         * symbol override.  Wraps around after the last symbol.
         * Called by the Symbol Rotation Blockly block.
         * @param {string} group
         */
        rotateSymbol: group => tradeEngine.rotateSymbol(group),
        setVirtualHookEnabled: enabled => tradeEngine.setVirtualHookEnabled(enabled),
        /**
         * Configure the Virtual Hook engine.
         * Called by the Virtual Hook Settings Blockly block.
         *
         * @param {number} virtualTradeCount    How many virtual trades to run (default 21).
         * @param {number} realWinsBeforeReset  Real wins before a new virtual sequence (default 1).
         */
        setVirtualHookSettings: (virtualTradeCount, realWinsBeforeReset) =>
            tradeEngine.setVirtualHookSettings(virtualTradeCount, realWinsBeforeReset),
        /**
         * Returns true when the Virtual Hook is actively running virtual
         * (simulated) trades.  Called by the Virtual Hook Status Blockly block.
         *
         * @returns {boolean}
         */
        getVirtualHookStatus: () => tradeEngine.getVirtualHookStatus(),
        getAskPrice: contract_type => Number(getProposal(contract_type, tradeEngine).ask_price),
        getPayout: contract_type => Number(getProposal(contract_type, tradeEngine).payout),
        getPurchaseReference: () => tradeEngine.getPurchaseReference(),
        isSellAvailable: () => tradeEngine.isSellAtMarketAvailable(),
        sellAtMarket: () => tradeEngine.sellAtMarket(),
        getSellPrice: () => getSellPrice(tradeEngine),
        isResult: result => getDetail(10) === result,
        isTradeAgain: result => globalObserver.emit('bot.trade_again', result),
        readDetails: i => getDetail(i - 1),
    };
};

const getProposal = (contract_type, tradeEngine) => {
    return tradeEngine.data.proposals.find(
        proposal =>
            proposal.contract_type === contract_type &&
            proposal.purchase_reference === tradeEngine.getPurchaseReference()
    );
};

const getSellPrice = tradeEngine => {
    return tradeEngine.getSellPrice();
};

export default getBotInterface;
