import { VirtualHookRuntime } from '../runtime/VirtualHookRuntime';
import { tradeOptionToProposal } from '../utils/helpers';
import { notify } from '../utils/broadcast';
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

        // ── Runtime mode ─────────────────────────────────────────────────────

        /**
         * Set a named execution mode shared across all blocks in the current run.
         * Called by Bot.setMode(mode).
         *
         * @param {string} mode  e.g. 'NORMAL' | 'RECOVERY' | 'WAIT' | 'PAUSE' | 'CUSTOM'
         */
        setMode(mode) {
            this.activeMode = typeof mode === 'string' ? mode : 'NORMAL';
        }

        /**
         * Return the current execution mode.  Defaults to 'NORMAL' if never set.
         * Called by Bot.getMode().
         *
         * @returns {string}
         */
        getMode() {
            return this.activeMode || 'NORMAL';
        }


        // ── Prediction helpers ────────────────────────────────────────────────

        /**
         * Pick a random digit in [min, max] (inclusive) and set it as the
         * active prediction override.
         * Called by Bot.setRandomPrediction(min, max).
         *
         * @param {number} min  Lower bound (0–9)
         * @param {number} max  Upper bound (0–9)
         */
        setRandomPrediction(min, max) {
            const lo = Math.ceil(Number(min));
            const hi = Math.floor(Number(max));
            const prediction = lo + Math.floor(Math.random() * (hi - lo + 1));
            this.setActivePredictionOverride(prediction);
        }

        // ── Symbol helpers ────────────────────────────────────────────────────

        /**
         * Symbol groups used by setRandomSymbol and rotateSymbol.
         * Keys mirror the GROUP dropdown values defined in the Blockly blocks.
         */
        static SYMBOL_GROUPS = {
            volatility:    ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
            volatility_1s: ['1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'],
            boom_crash:    ['BOOM300N', 'BOOM500', 'BOOM1000', 'CRASH300N', 'CRASH500', 'CRASH1000'],
            step_index:    ['stpRNG'],
            jump:          ['JD10', 'JD25', 'JD50', 'JD75', 'JD100'],
        };

        /**
         * Pick a random symbol from the given group and apply it as the
         * active symbol override.
         * Called by Bot.setRandomSymbol(group).
         *
         * @param {string} group  Key from SYMBOL_GROUPS
         */
        setRandomSymbol(group) {
            const symbols =
                ActiveContract.SYMBOL_GROUPS[group] ??
                ActiveContract.SYMBOL_GROUPS.volatility;
            const symbol = symbols[Math.floor(Math.random() * symbols.length)];
            this.setActiveSymbolOverride(symbol);
        }

        /**
         * Rotate to the next symbol in the given group (wraps around) and apply
         * it as the active symbol override.
         * Called by Bot.rotateSymbol(group).
         *
         * @param {string} group  Key from SYMBOL_GROUPS
         */
        rotateSymbol(group) {
            const symbols =
                ActiveContract.SYMBOL_GROUPS[group] ??
                ActiveContract.SYMBOL_GROUPS.volatility;
            if (!this._rotationIndices) this._rotationIndices = {};
            const idx = (this._rotationIndices[group] ?? 0) % symbols.length;
            this._rotationIndices[group] = idx + 1;
            this.setActiveSymbolOverride(symbols[idx]);
        }

        // ── Smart purchase ────────────────────────────────────────────────────

        /**
         * Purchase using the currently effective contract type — respects any
         * active contract override without the caller needing to know it.
         * Falls back to the first available proposal type if no override is set.
         * Called by Bot.purchaseCurrentContract().
         */
        purchaseCurrentContract() {
            const type =
                this.activeContractOverride ??
                (this.data?.proposals?.[0]?.contract_type ?? null);
            if (!type) {
                throw new Error('purchaseCurrentContract: no contract type available.');
            }
            return this.purchase(type);
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
                notify('notify-virtual-hook', 'Virtual Hook Enabled');
                notify('notify-virtual-hook', 'Virtual Hook Authorized');
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
