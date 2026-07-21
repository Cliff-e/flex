import { tradeOptionToProposal } from '../utils/helpers';

/**
 * ActiveContract mixin
 *
 * Maintains an optional runtime override for the current contract type.
 * When set, every subsequent proposal / purchase uses this type until
 * another setActiveContractOverride call (or until the bot stops).
 *
 * If no override is set the engine behaves exactly as before — full
 * backward compatibility with existing bots that don't use the switcher.
 */
export default Engine =>
    class ActiveContract extends Engine {
        /**
         * Called by the Blockly-generated code: Bot.setActiveContract(type)
         *
         * 1. Store the override.
         * 2. Force new proposals to be requested for this contract type by
         *    clearing the cached trade_option (so isNewTradeOption returns true)
         *    and rebuilding proposal_templates with the overridden contractTypes.
         *
         * @param {string} contractType  – e.g. 'DIGITOVER', 'CALL', 'DIGITEVEN'
         */
        setActiveContractOverride(contractType) {
            this.activeContractOverride = contractType;

            // Only re-request proposals if the engine has already started trading
            // (i.e. trade_option has been set by a prior makeProposals call).
            if (this.trade_option) {
                const overridden_trade_option = {
                    ...this.trade_option,
                    contractTypes: [contractType],
                };

                // Nullify the cached trade_option so that isNewTradeOption()
                // treats the next makeProposals call as a genuinely new trade.
                this.trade_option = null;

                // Generate a fresh purchase reference so stale proposals from
                // the old contract type are ignored.
                this.regeneratePurchaseReference();

                // Build new proposal templates directly (same path as makeProposals
                // but bypassing the isNewTradeOption guard).
                this.proposal_templates = tradeOptionToProposal(
                    overridden_trade_option,
                    this.getPurchaseReference()
                );

                // Flush existing proposals and request fresh ones.
                this.renewProposalsOnPurchase();
            }
        }

        /**
         * Clear the active contract override (reverts to the trade-definition
         * contract type on the next trade cycle).  Not currently exposed to
         * Blockly but available for future blocks (e.g. AI Strategy Selector).
         */
        clearActiveContractOverride() {
            this.activeContractOverride = null;
        }
    };
