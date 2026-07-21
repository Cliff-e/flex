import { tradeOptionToProposal } from '../utils/helpers';

/**
 * ActiveContract mixin
 *
 * Maintains two optional runtime overrides:
 *   - activeContractOverride  (set by Contract Type Switcher block)
 *   - activeSymbolOverride    (set by Symbol Changer block)
 *
 * When an override is set it takes priority over the Trade Parameters value.
 * When an override is cleared (value === 'DISABLE') the engine falls back to
 * the original value from Trade Parameters — making Trade Parameters the
 * permanent default configuration.
 *
 * Bots that contain neither block are completely unaffected (both overrides
 * remain undefined/null the entire run).
 */
export default Engine =>
    class ActiveContract extends Engine {
        // ─── Contract type override ───────────────────────────────────────────

        /**
         * Called by Bot.setActiveContract(type).
         * Pass 'DISABLE' to clear the override and revert to Trade Parameters.
         *
         * @param {string} contractType  e.g. 'DIGITOVER' | 'CALL' | 'DISABLE'
         */
        setActiveContractOverride(contractType) {
            this.activeContractOverride = contractType === 'DISABLE' ? null : contractType;
            this._rebuildProposals();
        }

        // ─── Symbol override ──────────────────────────────────────────────────

        /**
         * Called by Bot.setActiveSymbol(symbol).
         * Pass 'DISABLE' to clear the override and revert to Trade Parameters.
         *
         * @param {string} symbol  e.g. 'R_10' | '1HZ100V' | 'DISABLE'
         */
        setActiveSymbolOverride(symbol) {
            this.activeSymbolOverride = symbol === 'DISABLE' ? null : symbol;
            this._rebuildProposals();
        }

        // ─── Shared rebuild helper ────────────────────────────────────────────

        /**
         * Rebuilds proposal templates using the effective contract types and
         * symbol (overrides take priority; fall back to original options when
         * no override is active).  No-ops if the engine has not yet started
         * trading (trade_option not yet populated).
         *
         * @private
         */
        _rebuildProposals() {
            if (!this.trade_option) return;

            // Determine the effective contract types.
            const effectiveContractTypes = this.activeContractOverride
                ? [this.activeContractOverride]
                : this.options.contractTypes;

            // Determine the effective symbol.
            const effectiveSymbol = this.activeSymbolOverride ?? this.options.symbol;

            const overridden_trade_option = {
                ...this.trade_option,
                contractTypes: effectiveContractTypes,
                symbol: effectiveSymbol,
                // The proposal API field mirrors symbol — keep them in sync.
                underlying_symbol: effectiveSymbol,
            };

            // Nullify the cache so isNewTradeOption() treats this as a new trade.
            this.trade_option = null;

            // Fresh purchase reference — stale proposals from the old
            // contract type / symbol will be ignored.
            this.regeneratePurchaseReference();

            this.proposal_templates = tradeOptionToProposal(
                overridden_trade_option,
                this.getPurchaseReference()
            );

            // Flush existing proposals and request fresh ones.
            this.renewProposalsOnPurchase();
        }
    };
