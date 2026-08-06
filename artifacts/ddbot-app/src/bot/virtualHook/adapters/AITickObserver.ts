// =============================================================
// AITickObserver — TickObserver backed by PublicTickManager
//
// This adapter wraps the existing shared AI tick infrastructure
// (PublicTickManager) so the VirtualHookEngine can observe market
// ticks WITHOUT creating a second WebSocket.
//
// One market stream. Multiple consumers. Virtual Hook is one.
// =============================================================

import type { TickObserver, VHTick } from '../TickObserver';
import type { PublicTick } from '../../../utils/PublicTickManager';
import { PublicTickManager } from '../../../utils/PublicTickManager';

/**
 * Tick observer backed by the AI shared PublicTickManager.
 *
 * This adapter does NOT create a new WebSocket — it reuses the
 * existing PublicTickManager.subscribe() that the AI TradingEngine
 * already uses for tick monitoring.
 */
export class AITickObserver implements TickObserver {
    private _currentSymbol: string | null = null;
    private _unsub: (() => void) | null = null;
    private _active = false;

    /**
     * Start observing ticks for the given symbol.
     *
     * Uses the shared PublicTickManager.subscribe() — the same feed
     * the AI engine already subscribes to. No new WebSocket is created.
     */
    async start(symbol: string, onTick: (tick: VHTick) => void): Promise<void> {
        // Stop any active subscription first (idempotent).
        if (this._active) {
            await this.stop();
        }

        this._currentSymbol = symbol;

        this._unsub = PublicTickManager.subscribe(symbol, (tick: PublicTick) => {
            const vhTick: VHTick = {
                quote: tick.quote,
                epoch: tick.epoch,
                digit: extractDigitValue(tick.quote),
            };
            onTick(vhTick);
        });

        this._active = true;
    }

    /**
     * Stop observing ticks. Idempotent — safe to call multiple times.
     */
    async stop(): Promise<void> {
        if (!this._active) return;

        this._unsub?.();
        this._unsub = null;
        this._active = false;
        this._currentSymbol = null;
    }

    /**
     * Whether observation is currently active.
     */
    isActive(): boolean {
        return this._active;
    }
}

/**
 * Extract the last digit (0–9) from a raw tick value using the
 * same canonical logic as XmlTickObserver and VirtualContract.
 */
function extractDigitValue(raw: string | number): number {
    return Number(String(raw).replace('.', '').slice(-1));
}