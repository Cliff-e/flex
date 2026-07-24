import { VirtualHookRuntime } from '../runtime/VirtualHookRuntime';
import { tradeOptionToProposal } from '../utils/helpers';
import { OPPOSITE_CONTRACT_MAP } from './Purchase';

/**
 * ActiveContract mixin
 *
 * Responsibilities
 * ────────────────
 * 1. Runtime proposal overrides — contract type, symbol, prediction.
 *    Each override is applied transparently whenever a new proposal is
 *    requested.  Clearing an override reverts to the Trade Parameters value.
 *
 * 2. Virtual Hook integration — thin delegation layer to VirtualHookRuntime.
 *    All state and logic live in `this.virtualHookRuntime`; this mixin only
 *    exposes the engine-facing API expected by BotInterface and Purchase.
 *
 * Bots that contain none of the override/VH blocks are completely unaffected:
 * overrides stay null and VirtualHookRuntime stays disabled throughout the run.
 */
export default Engine =>
    class ActiveContract extends Engine {
        // ── Virtual Hook runtime ──────────────────────────────────────────────

        /**
         * Single source of truth for all Virtual Hook state.
         * Purchase.js, OpenContract.js, and BotInterface.js all read this
         * instance through `this.virtualHookRuntime`.
         */
        virtualHookRuntime = new VirtualHookRuntime();

        // ── Contract type override ────────────────────────────────────────────

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

        // ── Symbol override ───────────────────────────────────────────────────

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

        // ── Prediction override ───────────────────────────────────────────────

        /**
         * Called by Bot.setActivePrediction(prediction).
         * Pass -1 to clear the override and revert to Trade Parameters.
         *
         * @param {number} prediction  Digit 0–9, or -1 to clear the override.
         */
        setActivePredictionOverride(prediction) {
            const pred = Number(prediction);
            this.activePredictionOverride = (pred === -1 || isNaN(pred)) ? null : pred;
            this._rebuildProposals();
        }

        // ── Virtual Hook delegation (BotInterface-facing API) ─────────────────

        /**
         * Enable or disable the Virtual Hook engine.
         * Called by Bot.setVirtualHookEnabled() from the VH Toggle Blockly block.
         *
         * @param {boolean} enabled
         */
        setVirtualHookEnabled(enabled) {
            if (Boolean(enabled)) {
                this.virtualHookRuntime.enable();
            } else {
                this.virtualHookRuntime.disable();
            }
        }

        /**
         * Configure virtual trade count and real-wins threshold.
         * Called by Bot.setVirtualHookSettings() from the VH Settings Blockly block.
         *
         * @param {number} virtualTradeCount    Virtual trades per sequence (default 21).
         * @param {number} realWinsBeforeReset  Real wins before reset (default 1).
         */
        setVirtualHookSettings(virtualTradeCount, realWinsBeforeReset) {
            this.virtualHookRuntime.configure(virtualTradeCount, realWinsBeforeReset);
        }

        /**
         * Returns true when the hook is active and running virtual trades.
         * Called by Bot.getVirtualHookStatus() from the VH Status Blockly block.
         *
         * @returns {boolean}
         */
        getVirtualHookStatus() {
            return this.virtualHookRuntime.getStatus();
        }

        // ── Shared proposal helpers ───────────────────────────────────────────

        /**
         * Returns a copy of `trade_option` with all active overrides applied.
         * Used by makeProposals and _rebuildProposals.
         *
         * @param {object} trade_option
         * @returns {object}
         */
        _applyActiveOverrides(trade_option) {
            // When an override is active, always subscribe proposals for both
            // the override type AND its opposite.  This guarantees that hedge()
            // can call selectProposal(opposite) without failing — even when the
            // Contract Type Switcher has restricted the default set to one type.
            let effectiveContractTypes;
            if (this.activeContractOverride) {
                const opposite = OPPOSITE_CONTRACT_MAP[this.activeContractOverride];
                effectiveContractTypes = opposite
                    ? [this.activeContractOverride, opposite]
                    : [this.activeContractOverride];
            } else {
                effectiveContractTypes = trade_option.contractTypes;
            }

            const effectiveSymbol = this.activeSymbolOverride ?? trade_option.symbol;

            const effective = {
                ...trade_option,
                contractTypes: effectiveContractTypes,
                symbol: effectiveSymbol,
                underlying_symbol: effectiveSymbol,
            };

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
         * whenever the engine starts a new trade cycle.
         */
        makeProposals(trade_option) {
            return super.makeProposals(this._applyActiveOverrides(trade_option));
        }

        /**
         * Flush and rebuild proposals using the current effective options.
         * No-ops if the engine has not yet started (trade_option not set).
         *
         * @private
         */
        _rebuildProposals() {
            if (!this.trade_option) return;

            const overridden_trade_option = this._applyActiveOverrides(this.trade_option);

            // Nullify the cache so isNewTradeOption() treats this as a new trade.
            this.trade_option = null;

            // Fresh reference ensures stale proposals from the old options are ignored.
            this.regeneratePurchaseReference();

            this.proposal_templates = tradeOptionToProposal(
                overridden_trade_option,
                this.getPurchaseReference()
            );

            this.renewProposalsOnPurchase();
        }
    };
