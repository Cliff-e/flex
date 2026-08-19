import { VirtualHookEngine } from '@/bot/virtualHook';
import { getVHTransactionPipeline } from '@/bot/virtualHook/VHRuntime';
import { XmlProposalAdapter } from '@/bot/virtualHook/adapters/XmlProposalAdapter';
import { XmlTickObserver } from '@/bot/virtualHook/adapters/XmlTickObserver';
import { tradeOptionToProposal } from '../utils/helpers';
import { notify } from '../utils/broadcast';
import { api_base } from '../../api/api-base';
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
 * 2. Virtual Hook integration — thin delegation layer to VirtualHookEngine.
 *    All state and logic live in `this.virtualHookEngine`; this mixin only
 *    exposes the engine-facing API expected by BotInterface and Purchase.
 *
 * Bots that contain none of the override/VH blocks are completely unaffected:
 * overrides stay null and VirtualHookEngine stays disabled throughout the run.
 */
export default Engine =>
    class ActiveContract extends Engine {
        // ── Virtual Hook engine ──────────────────────────────────────────────

        /**
         * Single source of truth for all Virtual Hook state.
         * Purchase.js, OpenContract.js, and BotInterface.js all read this
         * instance through `this.virtualHookEngine`.
         *
         * Lazily constructed (see _ensureVirtualHookEngine()) so the adapters
         * can capture live references to tradeOptions, symbol, prediction,
         * api_base, and ticksService after the engine has started.
         */
        virtualHookEngine = null;

        /**
         * Runtime VH mode flag — true while the Virtual Hook is actively
         * gating purchases. Set exclusively by setVirtualHookEnabled()
         * (re-initialized each Run via codegen `Bot.setVirtualHookEnabled`)
         * and cleared by deactivateVirtualHookRuntime() (switch-to-real on
         * AUTHORIZED).
         *
         * IMPORTANT: this flag is never consulted directly mid-flight for
         * a gate decision. Every purchase latches its value at entry
         * (`enteredWhileVH`) and the latch alone governs that purchase's
         * whole async lifecycle — a manual disable, policy deactivation,
         * or AUTHORIZED before settlement can never promote a latched
         * purchase to a real buy.
         */
        _vhRuntimeActive = false;

        /**
         * Lazily construct the VirtualHookEngine with XML adapters.
         * Called on first VH enable or VH status query.
         */
        _ensureVirtualHookEngine() {
            if (this.virtualHookEngine) {
                return this.virtualHookEngine;
            }

            const proposalAdapter = new XmlProposalAdapter({
                send: request => api_base.api.send(request),
                getTradeOptions: () => this.tradeOptions ?? null,
                getSymbol: () => this.activeSymbolOverride ?? this.tradeOptions?.symbol ?? '',
                getPrediction: () => this.activePredictionOverride ?? this.tradeOptions?.prediction ?? null,
                tradeOptionToProposal,
            });

            const tickObserver = new XmlTickObserver({
                ticksService: this.$scope?.ticksService,
                getSymbol: () => this.activeSymbolOverride ?? this.tradeOptions?.symbol ?? '',
            });

            this.virtualHookEngine = new VirtualHookEngine(
                proposalAdapter,
                tickObserver,
                getVHTransactionPipeline()
            );

            return this.virtualHookEngine;
        }

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
                this._ensureVirtualHookEngine().configure({ enabled: true });
                // Runtime mode ON — every NEW purchase latches this at entry.
                this._vhRuntimeActive = true;
                notify('notify-virtual-hook', 'Virtual Hook Enabled');
                notify('notify-virtual-hook', 'Virtual Hook Authorized');
            } else {
                this._ensureVirtualHookEngine().configure({ enabled: false });
                // Runtime mode OFF — in-flight latched purchases are
                // unaffected; their latch governs until settlement.
                this._vhRuntimeActive = false;
            }
        }

        /**
         * Switch-to-real deactivation of the VH runtime mode.
         *
         * Called exclusively when a purchase latched while VH was active
         * receives AUTHORIZED — after virtual settlement and record commit
         * have completed inside virtualHookEngine.start(). The latched
         * purchase itself is DISCARDED (zero real buys); this method only
         * clears the runtime mode so the NEXT new purchase enters
         * unlatched and uses the existing real pipeline unchanged.
         * Policy counters are untouched — the engine is merely disabled,
         * never reconfigured.
         */
        deactivateVirtualHookRuntime() {
            this._vhRuntimeActive = false;
            if (this.virtualHookEngine) {
                this.virtualHookEngine.configure({ enabled: false });
            }
        }

        /**
         * Configure the Virtual Hook pre-trade filter.
         * Called by Bot.setVirtualHookSettings() from the Trade Parameters block
         * and the Virtual Hook Settings Blockly block.
         *
         * @param {number} winThreshold    Consecutive wins threshold.
         * @param {boolean} winEnabled     Whether the win threshold is enabled.
         * @param {number} lossThreshold   Consecutive losses threshold.
         * @param {boolean} lossEnabled    Whether the loss threshold is enabled.
         * @param {number} maxSteps        Completed VH instances threshold.
         * @param {boolean} stepsEnabled    Whether the instance threshold is enabled.
         * @param {number} [stake]   Virtual stake — display only, never affects real trades.
         */
        setVirtualHookSettings(
            winThreshold,
            winEnabled,
            lossThreshold,
            lossEnabled,
            maxSteps,
            stepsEnabled,
            stake
        ) {
            const overrides = {
                winThreshold: Math.max(0, Number(winThreshold) || 0),
                winThresholdEnabled: winEnabled !== false,
                lossThreshold: Math.max(0, Number(lossThreshold) || 0),
                lossThresholdEnabled: lossEnabled === true,
                maxSteps: Math.max(0, Number(maxSteps) || 0),
                maxStepsEnabled: stepsEnabled !== false,
            };
            if (stake !== undefined && stake !== null) {
                // Clamp to the Deriv minimum so virtualStake is always valid.
                overrides.virtualStake = Math.max(Number(stake) || 1.0, 0.35);
            }
            this._ensureVirtualHookEngine().configure(overrides);
        }

        /**
         * Returns true when the hook is active and running virtual trades.
         * Called by Bot.getVirtualHookStatus() from the VH Status Blockly block.
         *
         * @returns {boolean}
         */
        getVirtualHookStatus() {
            return this._ensureVirtualHookEngine().getStatus().active;
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
         * ── VH PROTECTION ──────────────────────────────────────────────────────
         * When the Virtual Hook is actively evaluating a signal
         * (virtualHookEngine.getStatus().active returns true), proposals must
         * NOT be invalidated.  VH is
         * observing market ticks via the store, not via proposals, so stale
         * proposals do not affect its decision.  Invalidating proposals mid-
         * evaluation would cause the re-entrant purchase() call to fail with
         * "Selected proposal does not exist".
         *
         * Instead, when VH is active:
         *   • Defer the rebuild until VH completes.
         *   • Store the override request so it is applied after
         *     the authorised trade goes through.
         *
         * This ensures that _rebuildProposals() called from a Contract Changer,
         * Symbol Changer, or Prediction Changer block while VH is evaluating
         * does NOT break the in-flight trade.
         *
         * @private
         */
        _rebuildProposals() {
            if (!this.trade_option) return;

            // ── VH guard: defer if Virtual Hook is evaluating ──────────
            if (this.virtualHookEngine?.getStatus()?.active) {
                // eslint-disable-next-line no-console
                console.log(
                    '[VH][_rebuildProposals] DEFERRED — Virtual Hook is actively evaluating.' +
                    ' The rebuild will apply on the next purchase cycle.'
                );
                // Mark that a deferred rebuild is pending.  The re-entrant
                // purchase() path in Purchase.js already handles stale
                // proposals by calling _rebuildProposals() again (this time
                // VH won't be active because we are past the filter).  After
                // that, any deferred override will have been applied.
                this._pendingRebuild = true;
                return;
            }

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

            // Clear the pending flag — the rebuild has been applied.
            this._pendingRebuild = false;
        }
    };
