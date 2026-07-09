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
};

export class BotEngine {
    private cycles = 0;
    private losses = 0;
    private profit = 0;
    private running = false;

    private maxCycles = 2;

    private signal!: TradeSignal;
    private getTicks!: () => (number | string)[];

    constructor(private config: BotConfig) {}

    // 🚀 START BOT
    start(
        signal: TradeSignal,
        getTicks: () => (number | string)[]
    ) {
        this.running = true;
        this.signal = signal;

        this.cycles = 0;
        this.losses = 0;
        this.profit = 0;

        this.getTicks = getTicks;

        console.log('🤖 Bot started (waiting for entry...)');

        this.waitForEntry();
    }

    stop() {
        this.running = false;
        console.log('🛑 Bot stopped');
    }

    // 🎯 WAIT FOR ENTRY (digit 5 or 6)
    private waitForEntry() {
        if (!this.running) return;

        const ticks = this.getTicks();

        if (!ticks || ticks.length === 0) {
            setTimeout(() => this.waitForEntry(), 300);
            return;
        }

        const last = ticks[ticks.length - 1];
        const digit = Number(String(last).slice(-1));

        if (digit === 5 || digit === 6) {
            console.log(`🎯 Entry hit on digit ${digit}`);
            this.runCycle();
            return;
        }

        setTimeout(() => this.waitForEntry(), 200);
    }

    // 🔁 START CYCLE
    private runCycle() {
        if (!this.running) return;

        if (this.cycles >= this.maxCycles) {
            console.log('🎯 Completed all cycles');
            this.stop();
            return;
        }

        console.log(`🔁 Cycle ${this.cycles + 1}`);
        this.tradeOver1();
    }

    // 🔹 TRADE OVER 1
    private tradeOver1() {
        if (!this.running) return;

        const stake = this.getStake();

        console.log('📡 TRADE', {
            contract: this.signal.contract,
            barrier: this.signal.barrier,
            stake
        });

        const win = this.simulate();

        if (win) {
            this.finishCycle(stake);
        } else {
            this.losses++;
            console.log('❌ Lost OVER 1 → UNDER 5');
            setTimeout(() => this.tradeUnder5(stake), 800);
        }
    }

    // 🔻 RECOVERY STEP → UNDER 5
    private tradeUnder5(stake: number) {
        if (!this.running) return;

        console.log('📡 UNDER 5');

        const win = this.simulate();

        if (win) {
            this.finishCycle(stake);
        } else {
            this.losses++;
            console.log('❌ Lost UNDER 5 → OVER 5 loop');
            this.tradeOver5Loop(stake);
        }
    }

    // 🔁 NON-BLOCKING LOOP → OVER 5 UNTIL WIN
    private tradeOver5Loop(stake: number) {
        if (!this.running) return;

        console.log('🔁 LOOP: OVER 5');

        const tryTrade = () => {
            if (!this.running) return;

            const win = this.simulate();

            if (win) {
                this.finishCycle(stake);
            } else {
                this.losses++;
                setTimeout(tryTrade, 800);
            }
        };

        tryTrade();
    }

    // ✅ COMPLETE ONE CYCLE
    private finishCycle(stake: number) {
        if (!this.running) return;

        this.cycles++;
        this.losses = 0;
        this.profit += stake;

        console.log(`✅ Cycle ${this.cycles}/${this.maxCycles}`);
        console.log(`💰 Profit: ${this.profit}`);

        // 🎯 STOP CONDITIONS
        if (this.config.targetWins && this.cycles >= this.config.targetWins) {
            console.log('🎯 Target wins reached');
            this.stop();
            return;
        }

        if (this.config.targetProfit && this.profit >= this.config.targetProfit) {
            console.log('💰 Target profit reached');
            this.stop();
            return;
        }

        if (this.profit <= -this.config.stopLoss) {
            console.log('🛑 Stop loss hit');
            this.stop();
            return;
        }

        // 🔁 WAIT FOR NEXT ENTRY
        setTimeout(() => this.waitForEntry(), 500);
    }

    // 💰 MARTINGALE
    private getStake() {
        return this.config.stake * Math.pow(this.config.martingale, this.losses);
    }

    // 🎲 SIMULATION (replace later with real API)
    private simulate() {
        return Math.random() > 0.45;
    }
}