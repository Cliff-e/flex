// =============================================================
// XmlTickObserver — TickObserver backed by ticksService
//
// This adapter wraps the existing shared tick monitoring
// infrastructure (ticksService) so the VirtualHookEngine can
// observe market ticks WITHOUT creating a second WebSocket.
//
// One market stream. Multiple consumers. Virtual Hook is one.
// =============================================================

import type { TickObserver, VHTick } from '../TickObserver';

/**
 * Minimal signature of a raw tick from the ticksService.
 */
interface RawTick {
    epoch: number;
    quote: number;
}

/**
 * Signature of the ticksService monitor/stopMonitor API.
 */
export interface TicksServiceLike {
    monitor: (args: { symbol: string; callback: (ticks: RawTick[]) => void }) => Promise<string>;
    stopMonitor: (args: { symbol: string; key: string }) => Promise<void>;
}

/**
 * Options passed to the adapter at construction time.
 */
export interface XmlTickObserverOptions {
    /** The ticksService from $scope. */
    ticksService: TicksServiceLike;

    /** Callback that returns the current symbol (respects overrides). */
    getSymbol: () => string;
}

/**
 * Tick observer backed by the XML shared tick infrastructure.
 *
 * This adapter does NOT create a new WebSocket — it reuses the
 * existing ticksService.monitor() subscription that the XML bot
 * already maintains for watchTicks.
 */
export class XmlTickObserver implements TickObserver {
    private readonly _ticksService: TicksServiceLike;
    private readonly _getSymbol: () => string;

    private _currentSymbol: string | null = null;
    private _monitorKey: string | null = null;
    private _active = false;

    constructor(options: XmlTickObserverOptions) {
        this._ticksService = options.ticksService;
        this._getSymbol = options.getSymbol;
    }

    /**
     * Start observing ticks for the given symbol.
     *
     * Uses the shared ticksService.monitor() — the same feed the
     * XML bot already subscribes to. No new WebSocket is created.
     */
    async start(symbol: string, onTick: (tick: VHTick) => void): Promise<void> {
        // Stop any active subscription for a different symbol first
        // (idempotent — safe to call even when not monitoring).
        if (this._active && this._currentSymbol !== symbol) {
            await this.stop();
        }

        this._currentSymbol = symbol;

        // The callback receives an array of ticks; we emit only the
        // most recent tick per callback to keep the VH engine's
        // tick-at-a-time model intact.
        const callback = (ticks: RawTick[]) => {
            const lastTick = ticks.length > 0 ? ticks[ticks.length - 1] : null;
            if (!lastTick) return;

            const vhTick: VHTick = {
                quote: lastTick.quote,
                epoch: lastTick.epoch,
                digit: extractDigitValue(lastTick.quote),
            };
            onTick(vhTick);
        };

        const key = await this._ticksService.monitor({ symbol, callback });
        this._monitorKey = key;
        this._active = true;
    }

    /**
     * Stop observing ticks. Idempotent — safe to call multiple times.
     */
    async stop(): Promise<void> {
        if (!this._active) return;

        try {
            await this._ticksService.stopMonitor({
                symbol: this._currentSymbol ?? '',
                key: this._monitorKey ?? '',
            });
        } finally {
            this._active = false;
            this._monitorKey = null;
        }
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
 * same canonical logic as VirtualContract.extractDigitValue.
 */
function extractDigitValue(raw: string | number): number {
    return Number(String(raw).replace('.', '').slice(-1));
}