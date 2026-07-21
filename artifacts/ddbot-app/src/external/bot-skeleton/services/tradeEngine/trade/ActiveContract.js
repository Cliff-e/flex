import { tradeOptionToProposal } from '../utils/helpers';

/**
 * ActiveContract mixin
 *
 * Maintains optional runtime overrides:
 *   - activeContractOverride    (set by Contract Type Switcher block)
 *   - activeSymbolOverride      (set by Symbol Changer block)
 *   - activePredictionOverride  (set by Custom Prediction block)
 *
 * When an override is set it takes priority over the Trade Parameters value.
 * When an override is cleared the engine falls back to the original value from
 * Trade Parameters — making Trade Parameters the permanent default config.
 *
 * Bots that contain none of these blocks are completely unaffected (all
 * overrides remain null the entire run).
 *
 * Virtual Hook
 * ─────────────
 * Maintains the virtual trade warm-up state.  When virtualHookEnabled is true
 * and virtualHookActive is true, the Purchase mixin executes simulated trades
 * instead of real API calls.  After the configured number of virtual trades the
 * engine switches to real trading.  After the configured number of real wins the
 * virtual sequence resets and runs again.
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

        // ─── Prediction override ──────────────────────────────────────────────

        /**
         * Called by Bot.setActivePrediction(prediction).
         * Pass -1 to clear the override and revert to Trade Parameters.
         * Only affects contracts that use a prediction/barrier (Matches, Differs,
         * Over, Under). Silently ignored for other contract types.
         *
         * @param {number} prediction  Digit 0–9, or -1 to clear the override.
         */
        setActivePredictionOverride(prediction) {
            const pred = Number(prediction);
            this.activePredictionOverride = (pred === -1 || isNaN(pred)) ? null : pred;
            this._rebuildProposals();
        }

        // ─── Virtual Hook state ───────────────────────────────────────────────

        /** Whether the Virtual Hook system is switched on by the bot's XML. */
        virtualHookEnabled = false;

        /**
         * True while running virtual (simulated) trades.
         * False when the bot is in real trading mode.
         */
        virtualHookActive = false;

        /** How many virtual trades have been run in the current sequence. */
        virtualTradeCounter = 0;

        /** Total virtual trades to run before switching to real trading. */
        virtualTradeCount = 21;

        /** How many consecutive real wins trigger a new virtual sequence. */
        realWinsBeforeReset = 1;

        /** Consecutive real wins since the last virtual sequence completed. */
        realWinCounter = 0;

        /** History of virtual trade outcomes: 'win' | 'loss'. */
        virtualHistory = [];

        /**
         * Called by Bot.setVirtualHookEnabled(enabled).
         * Enabling activates the virtual hook immediately (starts virtual mode).
         * Disabling resets all virtual hook state and reverts to standard trading.
         *
         * @param {boolean} enabled
         */
        setVirtualHookEnabled(enabled) {
            this.virtualHookEnabled = Boolean(enabled);
            if (this.virtualHookEnabled) {
                // Activate virtual mode from the start.
                this.virtualHookActive = true;
                this.virtualTradeCounter = 0;
                this.realWinCounter = 0;
                this.virtualHistory = [];
            } else {
                // Disable — clear all virtual state.
                this.virtualHookActive = false;
                this.virtualTradeCounter = 0;
                this.realWinCounter = 0;
                this.virtualHistory = [];
            }
        }

        /**
         * Called by Bot.setVirtualHookSettings(virtualTrades, realWins).
         * Updates the virtual trade count and real-wins-before-reset thresholds.
         * Safe to call before or after enabling the hook.
         *
         * @param {number} virtualTradeCount     Default 21.
         * @param {number} realWinsBeforeReset   Default 1.
         */
        setVirtualHookSettings(virtualTradeCount, realWinsBeforeReset) {
            this.virtualTradeCount = Math.max(1, Number(virtualTradeCount) || 21);
            this.realWinsBeforeReset = Math.max(1, Number(realWinsBeforeReset) || 1);
        }

        /**
         * Returns true when the Virtual Hook is actively running virtual trades.
         * Called by Bot.getVirtualHookStatus().
         *
         * @returns {boolean}
         */
        getVirtualHookStatus() {
            return Boolean(this.virtualHookEnabled && this.virtualHookActive);
        }

        /**
         * Called by the Purchase mixin after each virtual trade completes.
         * Advances the virtual counter and switches to real mode when the
         * configured number of virtual trades has been reached.
         *
         * @param {boolean} won  Whether the virtual trade would have been a win.
         */
        onVirtualTradeComplete(won) {
            this.virtualHistory.push(won ? 'win' : 'loss');
            this.virtualTradeCounter++;

            if (this.virtualTradeCounter >= this.virtualTradeCount) {
                // Virtual warm-up complete — switch to real trading.
                this.virtualHookActive = false;
                this.virtualTradeCounter = 0;
                this.realWinCounter = 0;
            }
        }

        /**
         * Called by the OpenContract mixin after each real trade settles.
         * Tracks consecutive real wins and resets the virtual hook when the
         * configured threshold is reached.
         *
         * @param {boolean} won  Whether the real trade was a win.
         */
        onRealTradeComplete(won) {
            if (!this.virtualHookEnabled) return;

            if (won) {
                this.realWinCounter++;
                if (this.realWinCounter >= this.realWinsBeforeReset) {
                    // Enough real wins — trigger a new virtual warm-up sequence.
                    this.virtualHookActive = true;
                    this.virtualTradeCounter = 0;
                    this.realWinCounter = 0;
                    this.virtualHistory = [];
                }
            } else {
                // A loss resets the consecutive win counter.
                this.realWinCounter = 0;
            }
        }

        // ─── Shared helpers ───────────────────────────────────────────────────

        /**
         * Returns a copy of `trade_option` with all active overrides applied.
         * Used by makeProposals (override Proposal mixin) and _rebuildProposals.
         *
         * @param {object} trade_option
         * @returns {object}
         */
        _applyActiveOverrides(trade_option) {
            const effectiveContractTypes = this.activeContractOverride
                ? [this.activeContractOverride]
                : trade_option.contractTypes;

            const effectiveSymbol = this.activeSymbolOverride ?? trade_option.symbol;

            const effective = {
                ...trade_option,
                contractTypes: effectiveContractTypes,
                symbol: effectiveSymbol,
                underlying_symbol: effectiveSymbol,
            };

            // Only apply prediction override for contract types that support it.
            if (
                this.activePredictionOverride !== null &&
                this.activePredictionOverride !== undefined
            ) {
                effective.prediction = this.activePredictionOverride;
            }

            return effective;
        }

        /**
         * Override Proposal.makeProposals so active overrides are applied
         * whenever the engine starts a new trade — not just when an override
         * block fires a _rebuildProposals call.
         */
        makeProposals(trade_option) {
            return super.makeProposals(this._applyActiveOverrides(trade_option));
        }

        /**
         * Rebuilds proposal templates using the effective contract types,
         * symbol, and prediction (overrides take priority; fall back to original
         * options when no override is active).
         * No-ops if the engine has not yet started trading (trade_option not yet
         * populated).
         *
         * @private
         */
        _rebuildProposals() {
            if (!this.trade_option) return;

            const overridden_trade_option = this._applyActiveOverrides(this.trade_option);

            // Nullify the cache so isNewTradeOption() treats this as a new trade.
            this.trade_option = null;

            // Fresh purchase reference — stale proposals from the old options
            // will be ignored.
            this.regeneratePurchaseReference();

            this.proposal_templates = tradeOptionToProposal(
                overridden_trade_option,
                this.getPurchaseReference()
            );

            // Flush existing proposals and request fresh ones.
            this.renewProposalsOnPurchase();
        }
    };
