import type BotRuntimeStore from '@/stores/bot-runtime-store';
import type { RuntimeLogLevel } from '@/stores/bot-runtime-store';
import type { TContractInfo } from '@/components/summary/summary-card.types';

/**
 * Bridges plain TypeScript engines (which run outside of React/MobX context,
 * e.g. TradingEngine, BotEngine) to the shared BotRuntimeStore.
 *
 * Calls made before `attach()` is invoked are buffered and replayed once the
 * store becomes available, so engines never need to know about React
 * mount/init order.
 */
class RuntimeLoggerBridge {
    private store: BotRuntimeStore | null = null;
    private buffer: Array<(store: BotRuntimeStore) => void> = [];

    attach(store: BotRuntimeStore) {
        this.store = store;
        const pending = this.buffer;
        this.buffer = [];
        pending.forEach(fn => fn(store));
    }

    private run(fn: (store: BotRuntimeStore) => void) {
        if (this.store) {
            fn(this.store);
        } else {
            this.buffer.push(fn);
        }
    }

    registerBot(bot: { id: string; name: string; strategy?: string; market?: string }) {
        this.run(store => store.registerBot(bot));
    }

    start(id: string, meta: { name?: string; strategy?: string; market?: string; reset?: boolean } = {}) {
        this.run(store => store.start(id, meta));
    }

    pause(id: string) {
        this.run(store => store.pause(id));
    }

    resume(id: string) {
        this.run(store => store.resume(id));
    }

    stop(id: string) {
        this.run(store => store.stop(id));
    }

    updateSignal(id: string, signal: string) {
        this.run(store => store.updateSignal(id, signal));
    }

    updatePosition(id: string, position: string) {
        this.run(store => store.updatePosition(id, position));
    }

    setMarket(id: string, market: string) {
        this.run(store => store.setMarket(id, market));
    }

    recordTrade(id: string, contract: TContractInfo) {
        this.run(store => store.recordTrade(id, contract));
    }

    log(level: RuntimeLogLevel, message: string, botId?: string) {
        this.run(store => store.log(level, message, botId));
    }
}

export const RuntimeLogger = new RuntimeLoggerBridge();
