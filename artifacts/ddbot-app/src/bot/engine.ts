import { RuntimeLogger } from '../runtime/RuntimeLogger';

const SCANNER_BOT_RUNTIME_ID = 'ai-scanner';

type BotConfig = {
    stake: number;
    martingale: number;
    stopLoss: number;
    targetWins?: number;
    targetProfit?: number;
};

type TradeSignal = {
    symbol: string;
    contract: string;
    barrier: number;
    probability?: number;
};

export class BotEngine {
    private cycles = 0;
    private losses = 0;
    private profit = 0;
    private running = false;

    private maxCycles = 2;
    private getTicks!: () => (number | string)[];

    constructor(private config: BotConfig) {}

    // 🚀 START
    start(signal: TradeSignal, getTicks: () => (number | string)[]) {
        this.running = true;
        this.cycles = 0;
        this.losses = 0;
        this.profit = 0;
        this.getTicks = getTicks;

        RuntimeLogger.start(SCANNER_BOT_RUNTIME_ID, {
            name: 'AI Scanner',
            strategy: signal.contract,
            market: signal.symbol,
        });
        RuntimeLogger.log('INFO', 'Bot started (waiting for entry...)', SCANNER_BOT_RUNTIME_ID);

        this.waitForEntry();
    }

    stop() {
        this.running = false;
        RuntimeLogger.log('INFO', 'Bot stopped', SCANNER_BOT_RUNTIME_ID);
        RuntimeLogger.stop(SCANNER_BOT_RUNTIME_ID);
    }

    // 🎯 WAIT FOR ENTRY (5 or 6)
    private waitForEntry() {
        if (!this.running) return;

        const ticks = this.getTicks();

        if (!ticks || ticks.length === 0) {
            return setTimeout(() => this.waitForEntry(), 300);
        }

        const last = ticks[ticks.length - 1];
        const digit = Number(String(last).slice(-1));

        if (digit === 5 || digit === 6) {
            RuntimeLogger.log('INFO', `Entry hit on digit ${digit}`, SCANNER_BOT_RUNTIME_ID);
            RuntimeLogger.updateSignal(SCANNER_BOT_RUNTIME_ID, `Entry on digit ${digit}`);
            this.runCycle();
            return;
        }

        setTimeout(() => this.waitForEntry(), 200);
    }

    // 🔁 CYCLE
    private runCycle() {
        if (!this.running) return;

        if (this.cycles >= this.maxCycles) {
            RuntimeLogger.log('SUCCESS', 'Completed 2 cycles', SCANNER_BOT_RUNTIME_ID);
            return this.stop();
        }

        RuntimeLogger.log('INFO', `Cycle ${this.cycles + 1}`, SCANNER_BOT_RUNTIME_ID);
        this.tradeOver1();
    }

    // 🔹 OVER 1
    private tradeOver1() {
        const stake = this.getStake();

        RuntimeLogger.log('INFO', `OVER 1 — stake ${stake}`, SCANNER_BOT_RUNTIME_ID);

        const win = this.simulate();

        if (win) {
            this.finishCycle(stake);
        } else {
            this.losses++;
            RuntimeLogger.log('WARNING', 'Lost OVER 1 → UNDER 5', SCANNER_BOT_RUNTIME_ID);
            this.tradeUnder5(stake);
        }
    }

    // 🔻 UNDER 5
    private tradeUnder5(stake: number) {
        RuntimeLogger.log('INFO', 'UNDER 5', SCANNER_BOT_RUNTIME_ID);

        const win = this.simulate();

        if (win) {
            this.finishCycle(stake);
        } else {
            this.losses++;
            RuntimeLogger.log('WARNING', 'Lost UNDER 5 → OVER 5 loop', SCANNER_BOT_RUNTIME_ID);
            this.tradeOver5Loop(stake);
        }
    }

    // 🔁 OVER 5 LOOP
    private tradeOver5Loop(stake: number) {
        RuntimeLogger.log('INFO', 'LOOP: OVER 5', SCANNER_BOT_RUNTIME_ID);

        let win = false;

        while (!win && this.running) {
            this.losses++;
            win = this.simulate();
        }

        if (win) {
            this.finishCycle(stake);
        }
    }

    // ✅ FINISH CYCLE
    private finishCycle(stake: number) {
        this.cycles++;
        this.losses = 0;
        this.profit += stake;

        RuntimeLogger.log(
            'SUCCESS',
            `Cycle ${this.cycles}/${this.maxCycles} | Simulated profit: ${this.profit}`,
            SCANNER_BOT_RUNTIME_ID
        );

        // 🎯 STOP CONDITIONS
        if (this.config.targetWins && this.cycles >= this.config.targetWins) {
            RuntimeLogger.log('SUCCESS', 'Target wins reached', SCANNER_BOT_RUNTIME_ID);
            return this.stop();
        }

        if (this.config.targetProfit && this.profit >= this.config.targetProfit) {
            RuntimeLogger.log('SUCCESS', 'Target profit reached', SCANNER_BOT_RUNTIME_ID);
            return this.stop();
        }

        if (this.profit <= -this.config.stopLoss) {
            RuntimeLogger.log('ERROR', 'Stop loss hit', SCANNER_BOT_RUNTIME_ID);
            return this.stop();
        }

        // 🔁 WAIT FOR NEXT ENTRY
        setTimeout(() => this.waitForEntry(), 500);
    }

    // 💰 MARTINGALE
    private getStake() {
        return this.config.stake * Math.pow(this.config.martingale, this.losses);
    }

    // 🎲 SIMULATION (replace later with real API — logged as simulated, not
    // recorded to the shared Transactions ledger, to avoid corrupting real
    // financial trade history)
    private simulate() {
        return Math.random() > 0.45;
    }
}
