import { action, computed, makeObservable, observable } from 'mobx';
import { v4 as uuidv4 } from 'uuid';
import { MessageTypes } from '@/external/bot-skeleton';
import { TContractInfo } from '../components/summary/summary-card.types';
import RootStore from './root-store';

export type RuntimeLogLevel = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'DEBUG';
export type RuntimeBotStatus = 'idle' | 'running' | 'paused' | 'stopped';

export type RuntimeLogEntry = {
    id: string;
    timestamp: number;
    level: RuntimeLogLevel;
    message: string;
    bot_id?: string;
    bot_name?: string;
};

export type RuntimeBot = {
    id: string;
    name: string;
    strategy: string;
    market: string;
    status: RuntimeBotStatus;
    start_time: number | null;
    wins: number;
    losses: number;
    total_trades: number;
    net_profit: number;
    current_signal: string;
    current_position: string;
};

export type RuntimeSummary = {
    has_active_bot: boolean;
    bot_id: string | null;
    bot_name: string;
    active_strategy: string;
    status: RuntimeBotStatus;
    market: string;
    total_trades: number;
    wins: number;
    losses: number;
    win_rate: number;
    net_profit: number;
    current_signal: string;
    current_position: string;
    start_time: number | null;
};

const MAX_LOGS = 2000;

const EMPTY_RUNTIME_BOT = (): RuntimeBot => ({
    id: '',
    name: '',
    strategy: '',
    market: '',
    status: 'idle',
    start_time: null,
    wins: 0,
    losses: 0,
    total_trades: 0,
    net_profit: 0,
    current_signal: '--',
    current_position: '--',
});

export default class BotRuntimeStore {
    root_store: RootStore;

    bots: Record<string, RuntimeBot> = {};
    active_bot_id: string | null = null;
    logs: RuntimeLogEntry[] = [];

    constructor(root_store: RootStore) {
        makeObservable(this, {
            bots: observable,
            active_bot_id: observable,
            logs: observable.shallow,
            active_bot: computed,
            summary: computed,
            registerBot: action.bound,
            start: action.bound,
            pause: action.bound,
            resume: action.bound,
            stop: action.bound,
            updateSignal: action.bound,
            updatePosition: action.bound,
            setMarket: action.bound,
            recordTrade: action.bound,
            log: action.bound,
            clearLogs: action.bound,
        });

        this.root_store = root_store;
    }

    private ensureBot(id: string, defaults: Partial<RuntimeBot> = {}): RuntimeBot {
        if (!this.bots[id]) {
            this.bots[id] = { ...EMPTY_RUNTIME_BOT(), id, ...defaults };
        }
        return this.bots[id];
    }

    registerBot({
        id,
        name,
        strategy,
        market,
    }: {
        id: string;
        name: string;
        strategy?: string;
        market?: string;
    }) {
        const bot = this.ensureBot(id, { name, strategy: strategy ?? '', market: market ?? '' });
        bot.name = name;
        if (strategy) bot.strategy = strategy;
        if (market) bot.market = market;
        return bot;
    }

    start(id: string, meta: { name?: string; strategy?: string; market?: string; reset?: boolean } = {}) {
        const bot = this.ensureBot(id, { name: meta.name, strategy: meta.strategy, market: meta.market });
        if (meta.name) bot.name = meta.name;
        if (meta.strategy) bot.strategy = meta.strategy;
        if (meta.market) bot.market = meta.market;

        if (meta.reset !== false) {
            bot.wins = 0;
            bot.losses = 0;
            bot.total_trades = 0;
            bot.net_profit = 0;
            bot.current_signal = '--';
            bot.current_position = '--';
        }

        bot.status = 'running';
        bot.start_time = Date.now();
        this.active_bot_id = id;

        this.log('INFO', `${bot.name || id} started`, id);
    }

    pause(id: string) {
        const bot = this.bots[id];
        if (!bot) return;
        bot.status = 'paused';
        this.log('WARNING', `${bot.name || id} paused`, id);
    }

    resume(id: string) {
        const bot = this.bots[id];
        if (!bot) return;
        bot.status = 'running';
        this.active_bot_id = id;
        this.log('INFO', `${bot.name || id} resumed`, id);
    }

    stop(id: string) {
        const bot = this.bots[id];
        if (!bot) return;
        bot.status = 'stopped';
        this.log('INFO', `${bot.name || id} stopped`, id);
    }

    updateSignal(id: string, signal: string) {
        const bot = this.ensureBot(id);
        bot.current_signal = signal;
    }

    updatePosition(id: string, position: string) {
        const bot = this.ensureBot(id);
        bot.current_position = position;
    }

    setMarket(id: string, market: string) {
        const bot = this.ensureBot(id);
        bot.market = market;
    }

    /**
     * Records a completed or open trade for a bot. Completed trades update the
     * bot's aggregate stats and are pushed into the shared Transactions ledger
     * (and the live SummaryCard) so every bot's trades show up in one place.
     */
    recordTrade(id: string, contract: TContractInfo) {
        const bot = this.ensureBot(id);

        this.root_store.summary_card.onBotContractEvent(contract);
        this.root_store.transactions.onBotContractEvent(contract);

        if (contract.is_sold || contract.status === 'sold' || contract.is_expired) {
            const profit = Number(contract.profit ?? 0);
            bot.total_trades += 1;
            bot.net_profit += profit;
            if (profit > 0) bot.wins += 1;
            else if (profit < 0) bot.losses += 1;

            this.log(
                profit >= 0 ? 'SUCCESS' : 'ERROR',
                `${bot.name || id} trade closed — ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}`,
                id
            );
        }
    }

    log(level: RuntimeLogLevel, message: string, bot_id?: string) {
        const bot = bot_id ? this.bots[bot_id] : undefined;
        const entry: RuntimeLogEntry = {
            id: uuidv4(),
            timestamp: Date.now(),
            level,
            message,
            bot_id,
            bot_name: bot?.name,
        };

        this.logs = [entry, ...this.logs].slice(0, MAX_LOGS);

        // Mirror into the legacy Journal tab so existing UI keeps working.
        const message_type = level === 'ERROR' ? MessageTypes.ERROR : level === 'SUCCESS' ? MessageTypes.SUCCESS : MessageTypes.NOTIFY;
        const prefix = bot?.name ? `[${bot.name}] ` : '';
        try {
            this.root_store.journal.pushMessage(`${prefix}${message}`, message_type, 'journal__text');
        } catch {
            // Journal may not be ready yet during early bootstrap — safe to ignore.
        }
    }

    clearLogs() {
        this.logs = [];
    }

    get active_bot(): RuntimeBot | null {
        if (this.active_bot_id && this.bots[this.active_bot_id]) return this.bots[this.active_bot_id];

        const running = Object.values(this.bots).find(bot => bot.status === 'running');
        if (running) return running;

        const bots = Object.values(this.bots).sort((a, b) => (b.start_time ?? 0) - (a.start_time ?? 0));
        return bots[0] ?? null;
    }

    get summary(): RuntimeSummary {
        const bot = this.active_bot;

        if (!bot) {
            return {
                has_active_bot: false,
                bot_id: null,
                bot_name: '',
                active_strategy: '--',
                status: 'idle',
                market: '--',
                total_trades: 0,
                wins: 0,
                losses: 0,
                win_rate: 0,
                net_profit: 0,
                current_signal: '--',
                current_position: '--',
                start_time: null,
            };
        }

        const win_rate = bot.total_trades > 0 ? (bot.wins / bot.total_trades) * 100 : 0;

        return {
            has_active_bot: true,
            bot_id: bot.id,
            bot_name: bot.name,
            active_strategy: bot.strategy || '--',
            status: bot.status,
            market: bot.market || '--',
            total_trades: bot.total_trades,
            wins: bot.wins,
            losses: bot.losses,
            win_rate,
            net_profit: bot.net_profit,
            current_signal: bot.current_signal,
            current_position: bot.current_position,
            start_time: bot.start_time,
        };
    }
}
