// =============================================================
// VHSpecInvariants — dedicated Virtual Hook invariant regression
// suite (Task C / governing spec 2026-08-16).
//
// Invariants covered (BOTH engines where feasible):
//   (a) REAL-BUY GUARD      — VH active + gate resolves REJECTED /
//                             STOPPED / RETRY-exhausted / AUTHORIZED
//                             ⇒ ZERO buy sends for that signal.
//   (b) TRANSITION BOUNDARY — latched signal N completes a REAL
//                             virtual round and gets AUTHORIZED ⇒
//                             discarded (0 buys, VH runtime off);
//                             NEXT signal N+1 takes the existing
//                             real path with exactly ONE buy; N is
//                             never replayed.
//   (c) MID-ROUND DISABLE   — VH disabled DURING signal N's round ⇒
//                             N still produces ZERO real buys (mode
//                             latched at signal entry, not settlement).
//   (d) TICK OBSERVATION    — live monitoring ticks NEVER append to
//       ISOLATION             the shared exit-digit history; exactly
//                             one committed VH settlement appends
//                             once; duplicate commit stays at one.
//   (e) ACCOUNTING          — virtual win + loss are absorbed by the
//       ISOLATION             VH stores while the REAL transactions
//                             store / summary / engine P&L are
//                             untouched.
//
// Harness notes:
//   • AI gate tests reuse the WebSocketManager/EventBus spy harness
//     from TradingEngineVHLifecycle.test.ts.
//   • (b)/(c) AI tests drive the REAL VirtualHookEngine with the
//     fake adapters (never mock the engine's decision logic).
//   • XML tests drive the REAL Purchase.js gate (_runVirtualHookGate
//     / purchase) and the REAL ActiveContract.js runtime-mode
//     methods, asserting _executeRealPurchase is never reached for
//     latched purchases.
//   • (d)/(e) load the REAL sharedExitDigitHistory + VHRuntime +
//     stores inside jest.isolateModules (the file-level mocks below
//     are bypassed for those modules only).
// =============================================================

import { TradingEngine } from '../tradingEngine';
import type { TradingConfig } from '../tradingEngine';
import { VirtualHookEngine } from '../virtualHook/VirtualHookEngine';
import { VHDecision } from '../virtualHook/VHDecision';
import { getVHTransactionPipeline } from '../virtualHook/VHRuntime';
import { WebSocketManager } from '../../utils/WebSocketManager';
import { EventBus } from '../../utils/EventBus';

// ── Shared infra mocks (same harness as TradingEngineVHLifecycle) ──
jest.mock('../../utils/WebSocketManager', () => ({
    WebSocketManager: {
        connect: jest.fn().mockResolvedValue(undefined),
        send: jest.fn(),
    },
}));

jest.mock('../../utils/PublicTickManager', () => ({
    PublicTickManager: {
        subscribe: jest.fn().mockReturnValue(jest.fn()),
    },
}));

jest.mock('../../utils/EventBus', () => ({
    EventBus: {
        on: jest.fn().mockReturnValue(jest.fn()),
        emit: jest.fn(),
    },
    EventMap: {} as any,
}));

jest.mock('../../external/bot-skeleton', () => ({
    LogTypes: {},
}));

jest.mock('../../external/bot-skeleton/utils/observer', () => ({
    observer: {
        emit: jest.fn(),
        on: jest.fn(),
        off: jest.fn(),
    },
}));

jest.mock('../../external/bot-skeleton/services/tradeEngine/utils/normalize-contract', () => ({
    normalizeContractSpots: jest.fn((x: any) => x),
    normalizeContractFinancials: jest.fn((x: any) => x),
}));

jest.mock('../../external/bot-skeleton/services/api/api-base', () => ({
    api_base: {
        api: { send: jest.fn().mockResolvedValue({}) },
        clearSubscriptions: jest.fn(),
        is_stopping: false,
    },
}));

jest.mock('../../runtime/RuntimeLogger', () => ({
    RuntimeLogger: {
        start: jest.fn(),
        stop: jest.fn(),
        log: jest.fn(),
        recordTrade: jest.fn(),
        updateSignal: jest.fn(),
        updatePosition: jest.fn(),
    },
}));

jest.mock('../globalTickEngine', () => ({
    globalTickEngine: {
        getDigits: jest.fn().mockReturnValue([]),
    },
}));

jest.mock('../sharedExitDigitHistory', () => ({
    appendExitDigit: jest.fn(),
    resetExitDigitHistory: jest.fn(),
    getExitDigitHistory: jest.fn().mockReturnValue([]),
    getLastNConfirmedDigits: jest.fn().mockReturnValue([]),
}));

jest.mock('../virtualHook/VHRuntime', () => ({
    getVHTransactionPipeline: jest.fn().mockReturnValue({
        process: jest.fn().mockResolvedValue({ ok: true, warnings: [] }),
    }),
    resetVHRuntime: jest.fn(),
    getVHStore: jest.fn().mockReturnValue(null),
    isVHRuntimeWired: jest.fn().mockReturnValue(false),
}));

jest.mock('../virtualHook/adapters/AIProposalAdapter', () => ({
    AIProposalAdapter: jest.fn().mockImplementation(() => ({
        requestProposal: jest.fn().mockResolvedValue({
            ok: true,
            proposal: { id: 'vh-spec-prop', askPrice: 0.5, contractType: 'DIGITOVER', symbol: 'R_10' },
        }),
        abort: jest.fn(),
    })),
}));

// Emits WINNING ticks (digit 6) — DIGITOVER prediction 5 wins every round.
jest.mock('../virtualHook/adapters/AITickObserver', () => ({
    AITickObserver: jest.fn().mockImplementation(() => ({
        start: jest.fn().mockImplementation((_symbol: string, onTick: (t: any) => void) => {
            setTimeout(() => onTick({ quote: 1006, epoch: 1_700_000_000, digit: 6 }), 5);
            return Promise.resolve();
        }),
        stop: jest.fn().mockResolvedValue(undefined),
        isActive: jest.fn().mockReturnValue(false),
    })),
}));

// ── XML engine import-chain mocks (Purchase.js / ActiveContract.js) ──
jest.mock('../../external/bot-skeleton/constants/messages', () => ({
    LogTypes: { PROFIT: 'PROFIT', LOST: 'LOST', PURCHASE: 'PURCHASE' },
}));

jest.mock('../../external/bot-skeleton/services/tradeEngine/utils/broadcast', () => ({
    contract: jest.fn(),
    contractStatus: jest.fn(),
    info: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
    notify: jest.fn(),
}));

let mockUuidCounter = 0;
jest.mock('../../external/bot-skeleton/services/tradeEngine/utils/helpers', () => ({
    doUntilDone: jest.fn(),
    getUUID: jest.fn(() => `spec-uuid-${++mockUuidCounter}`),
    recoverFromError: jest.fn(),
    tradeOptionToBuy: jest.fn(),
    tradeOptionToProposal: jest.fn(),
}));

jest.mock('../../external/bot-skeleton/services/tradeEngine/trade/state/actions', () => ({
    openContractReceived: jest.fn(),
    purchaseSuccessful: jest.fn(() => ({ type: 'PURCHASE_SUCCESSFUL' })),
    sell: jest.fn(),
}));

jest.mock('../../external/bot-skeleton/services/tradeEngine/trade/state/constants', () => ({
    BEFORE_PURCHASE: 'BEFORE_PURCHASE',
    DURING_PURCHASE: 'DURING_PURCHASE',
    AFTER_PURCHASE: 'AFTER_PURCHASE',
}));

// Virtual mocks: '@/bot/...' has no jest moduleNameMapper entry, so
// Purchase.js / ActiveContract.js cannot resolve these paths natively.
// The string enum values MUST match VHDecision (string enum).
jest.mock(
    '@/bot/virtualHook',
    () => ({
        VHDecision: {
            AUTHORIZED: 'AUTHORIZED',
            REJECTED: 'REJECTED',
            RETRY: 'RETRY',
            STOPPED: 'STOPPED',
        },
        // Controllable fake engine for XML harnesses — per-instance
        // startImpl override drives the decision sequence.
        VirtualHookEngine: class MockXmlVHEngine {
            cfg: any = {};
            startImpl: ((candidate: any) => Promise<any>) | null = null;
            configure(partial: any): void {
                Object.assign(this.cfg, partial);
            }
            isEnabled(): boolean {
                return Boolean(this.cfg.enabled);
            }
            getStatus(): any {
                return { active: false, steps: 0, wins: 0, maxSteps: 5, minWins: 3 };
            }
            start(candidate: any): Promise<any> {
                if (this.startImpl) return this.startImpl(candidate);
                return Promise.resolve({
                    decision: 'AUTHORIZED',
                    reason: 'MOCK',
                    roundsCompleted: 1,
                    wins: 1,
                    losses: 0,
                });
            }
        },
    }),
    { virtual: true }
);

jest.mock(
    '@/bot/virtualHook/VHRuntime',
    () => ({
        getVHTransactionPipeline: jest.fn(() => ({
            process: jest.fn().mockResolvedValue({ ok: true, warnings: [] }),
        })),
    }),
    { virtual: true }
);

jest.mock(
    '@/bot/virtualHook/adapters/XmlProposalAdapter',
    () => ({
        XmlProposalAdapter: jest.fn().mockImplementation(() => ({
            requestProposal: jest.fn(),
            abort: jest.fn(),
        })),
    }),
    { virtual: true }
);

jest.mock(
    '@/bot/virtualHook/adapters/XmlTickObserver',
    () => ({
        XmlTickObserver: jest.fn().mockImplementation(() => ({
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn().mockResolvedValue(undefined),
            isActive: jest.fn().mockReturnValue(false),
        })),
    }),
    { virtual: true }
);

// Real XML engine modules (JS — pulled via require to keep TS quiet).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XmlPurchase: any =
    jest.requireActual('../../external/bot-skeleton/services/tradeEngine/trade/Purchase').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XmlActiveContract: any =
    jest.requireActual('../../external/bot-skeleton/services/tradeEngine/trade/ActiveContract').default;

jest.setTimeout(20_000);

// ──────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────

const baseConfig: TradingConfig = {
    strategy: 'DIFFER',
    symbol: 'R_10',
    stake: 1.0,
    martingaleMultiplier: 2,
    targetProfit: 100,
    stopLoss: 50,
    differDigits: [],
    vhConfig: { enabled: true, maxSteps: 3, minWins: 2 },
};

function getVHEngine(engine: TradingEngine): VirtualHookEngine | null {
    return (engine as any)._vhEngine;
}

/** All WebSocketManager.send payloads that are funded BUY requests. */
function getBuySends(): any[] {
    return (WebSocketManager.send as jest.Mock).mock.calls
        .map((call: any[]) => call[0])
        .filter((p: any) => Boolean(p) && 'buy' in p);
}

const AUTHORIZED_RESULT = {
    decision: VHDecision.AUTHORIZED,
    reason: 'MIN_WINS_REACHED',
    roundsCompleted: 3,
    wins: 2,
    losses: 1,
} as any;

const RETRY_RESULT = {
    decision: VHDecision.RETRY,
    reason: 'CONTINUE',
    roundsCompleted: 1,
    wins: 1,
    losses: 0,
} as any;

/**
 * Minimal harness object carrying the REAL Purchase.prototype gate
 * logic (_runVirtualHookGate / purchase) with controllable fields.
 */
function makeXmlPurchase(vhEngine: any) {
    // Purchase.js default export is a MIXIN FACTORY (Engine => class).
    const obj: any = new (XmlPurchase(class {}))();
    obj.store = {
        getState: () => ({ scope: 'BEFORE_PURCHASE', proposalsReady: true }),
        subscribe: jest.fn(() => jest.fn()),
        dispatch: jest.fn(),
    };
    obj._purchaseInProgress = false;
    obj._vhRuntimeActive = true;
    obj.virtualHookEngine = vhEngine;
    obj.deactivateVirtualHookRuntime = jest.fn(function (this: any) {
        this._vhRuntimeActive = false;
    });
    obj.tradeOptions = {
        symbol: 'R_100',
        amount: 10,
        duration: 1,
        duration_unit: 't',
        currency: 'USD',
        basis: 'stake',
        contractTypes: ['DIGITOVER'],
    };
    obj.activeContractOverride = null;
    obj.activeSymbolOverride = null;
    obj.activePredictionOverride = null;
    obj._executeRealPurchase = jest.fn(function (this: any) {
        this._purchaseInProgress = false;
        return Promise.resolve();
    });
    return obj;
}

/**
 * Full XML bot — REAL Purchase mixin over REAL ActiveContract mixin
 * (real setVirtualHookEnabled / deactivateVirtualHookRuntime).
 */
function makeXmlBot(): any {
    const Bot = XmlPurchase(XmlActiveContract(class {}));
    const bot: any = new Bot();
    bot.store = {
        getState: () => ({ scope: 'BEFORE_PURCHASE', proposalsReady: true }),
        subscribe: jest.fn(() => jest.fn()),
        dispatch: jest.fn(),
    };
    bot.tradeOptions = {
        symbol: 'R_100',
        amount: 10,
        duration: 1,
        duration_unit: 't',
        currency: 'USD',
        basis: 'stake',
        contractTypes: ['DIGITOVER'],
    };
    bot.data = { proposals: [] };
    bot.options = { timeMachineEnabled: false };
    bot.is_proposal_subscription_required = false;
    // Mirrors onSuccess(): clears the in-progress guard so subsequent
    // purchases can enter (exactly like a settled real buy would).
    bot._executeRealPurchase = jest.fn(function (this: any) {
        this._purchaseInProgress = false;
        return Promise.resolve();
    });
    return bot;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ──────────────────────────────────────────────────────────────
// (a) REAL-BUY GUARD — AI engine
//
// VH active; the gate resolves each terminal decision; assert ZERO
// funded buy messages leave the engine for that signal — at BOTH the
// WebSocket send layer and the _executeRealTrade call site.
// ──────────────────────────────────────────────────────────────

describe('(a) REAL-BUY GUARD — AI engine: zero buys on any gate decision', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    async function runGuardCase(decisionSetup: (vh: VirtualHookEngine) => void, rejectPattern: RegExp): Promise<void> {
        const engine = new TradingEngine(baseConfig);
        await engine.start();
        expect((engine as any)._vhActive).toBe(true);

        const realSpy = jest.fn().mockResolvedValue({ won: true, profit: 0.9, exitDigit: 5 });
        (engine as any)._executeRealTrade = realSpy;
        decisionSetup(getVHEngine(engine)!);

        await expect((engine as any)._executeTrade('DIGITOVER', '5', 1)).rejects.toThrow(rejectPattern);

        // ZERO buys at the real-path call site AND at the wire.
        expect(realSpy).not.toHaveBeenCalled();
        expect(getBuySends()).toHaveLength(0);

        engine.stop();
    }

    test('REJECTED ⇒ zero buy sends for the latched signal', async () => {
        await runGuardCase(vh => {
            jest.spyOn(vh, 'start').mockResolvedValue({
                decision: VHDecision.REJECTED,
                reason: 'MAX_STEPS_REACHED',
                roundsCompleted: 3,
                wins: 1,
                losses: 2,
            } as any);
        }, /VH REJECTED/);
    });

    test('STOPPED ⇒ zero buy sends for the latched signal', async () => {
        await runGuardCase(vh => {
            jest.spyOn(vh, 'start').mockResolvedValue({
                decision: VHDecision.STOPPED,
                reason: 'Abort requested by caller.',
                roundsCompleted: 0,
                wins: 0,
                losses: 0,
            } as any);
        }, /VH STOPPED/);
    });

    test('RETRY exhausted ⇒ zero buy sends (never falls through to real)', async () => {
        const engine = new TradingEngine(baseConfig);
        await engine.start();

        const realSpy = jest.fn().mockResolvedValue({ won: true, profit: 0.9, exitDigit: 5 });
        (engine as any)._executeRealTrade = realSpy;

        const vh = getVHEngine(engine)!;
        const startSpy = jest.spyOn(vh, 'start').mockResolvedValue(RETRY_RESULT);

        await expect((engine as any)._executeTrade('DIGITOVER', '5', 1))
            .rejects.toThrow(/VH RETRY exhausted/);

        // Bounded: exactly aiMaxRetries (3) gate consultations, no buy.
        expect(startSpy).toHaveBeenCalledTimes(3);
        expect(realSpy).not.toHaveBeenCalled();
        expect(getBuySends()).toHaveLength(0);

        engine.stop();
    });

    test('AUTHORIZED ⇒ the same signal buys once + VH runtime deactivated', async () => {
        const engine = new TradingEngine(baseConfig);
        await engine.start();

        const realSpy = jest.fn().mockResolvedValue({ won: true, profit: 0.9, exitDigit: 5 });
        (engine as any)._executeRealTrade = realSpy;

        const vh = getVHEngine(engine)!;
        jest.spyOn(vh, 'start').mockResolvedValue(AUTHORIZED_RESULT);

        await expect((engine as any)._executeTrade('DIGITOVER', '5', 1))
            .resolves.toEqual({ won: true, profit: 0.9, exitDigit: 5 });

        // The authorized signal is promoted exactly once.
        expect(realSpy).toHaveBeenCalledTimes(1);
        expect(realSpy).toHaveBeenCalledWith('DIGITOVER', '5', 1);
        expect(getBuySends()).toHaveLength(0);
        expect((engine as any)._vhActive).toBe(false);
        expect(vh.isEnabled()).toBe(false);

        engine.stop();
    });
});

// ──────────────────────────────────────────────────────────────
// (a) REAL-BUY GUARD — XML engine
//
// Drives the REAL Purchase._runVirtualHookGate decision router via
// purchase(); asserts _executeRealPurchase is never invoked for the
// latched purchase, for every decision.
// ──────────────────────────────────────────────────────────────

describe('(a) REAL-BUY GUARD — XML engine: _executeRealPurchase never reached', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('REJECTED ⇒ zero real purchases', async () => {
        const gate = makeXmlPurchase({
            start: jest.fn().mockResolvedValue({
                decision: VHDecision.REJECTED,
                reason: 'MAX_STEPS_REACHED',
                roundsCompleted: 5,
                wins: 2,
                losses: 3,
            }),
            isEnabled: jest.fn(() => true),
            configure: jest.fn(),
            getStatus: jest.fn(() => ({ active: false, steps: 0, wins: 0, maxSteps: 5, minWins: 3 })),
        });

        await gate.purchase('DIGITOVER');

        expect(gate._executeRealPurchase).not.toHaveBeenCalled();
        expect(gate._purchaseInProgress).toBe(false);
        // REJECTED does not deactivate the runtime mode.
        expect(gate._vhRuntimeActive).toBe(true);
    });

    test('STOPPED ⇒ zero real purchases', async () => {
        const gate = makeXmlPurchase({
            start: jest.fn().mockResolvedValue({
                decision: VHDecision.STOPPED,
                reason: 'Invalid TradeCandidate',
                roundsCompleted: 0,
                wins: 0,
                losses: 0,
            }),
            isEnabled: jest.fn(() => true),
            configure: jest.fn(),
            getStatus: jest.fn(() => ({ active: false, steps: 0, wins: 0, maxSteps: 5, minWins: 3 })),
        });

        await gate.purchase('DIGITOVER');

        expect(gate._executeRealPurchase).not.toHaveBeenCalled();
        expect(gate._purchaseInProgress).toBe(false);
    });

    test('RETRY exhausted ⇒ zero real purchases after bounded loop', async () => {
        const start = jest.fn().mockResolvedValue(RETRY_RESULT);
        const gate = makeXmlPurchase({
            start,
            isEnabled: jest.fn(() => true),
            configure: jest.fn(),
            getStatus: jest.fn(() => ({ active: false, steps: 0, wins: 0, maxSteps: 5, minWins: 3 })),
        });

        await gate.purchase('DIGITOVER');

        // Purchase.js bounds the loop at _vhMaxRetries (3).
        expect(start).toHaveBeenCalledTimes(3);
        expect(gate._executeRealPurchase).not.toHaveBeenCalled();
        expect(gate._purchaseInProgress).toBe(false);
    });

    test('AUTHORIZED ⇒ latched purchase promoted exactly once', async () => {
        const gate = makeXmlPurchase({
            start: jest.fn().mockResolvedValue(AUTHORIZED_RESULT),
            isEnabled: jest.fn(() => true),
            configure: jest.fn(),
            getStatus: jest.fn(() => ({ active: false, steps: 0, wins: 0, maxSteps: 5, minWins: 3 })),
        });

        await gate.purchase('DIGITOVER');

        expect(gate._executeRealPurchase).toHaveBeenCalledTimes(1);
        expect(gate._executeRealPurchase).toHaveBeenCalledWith('DIGITOVER', 'DIGITOVER');
        expect(gate.deactivateVirtualHookRuntime).toHaveBeenCalledTimes(1);
        expect(gate._vhRuntimeActive).toBe(false);
        expect(gate._purchaseInProgress).toBe(false);
    });
});

// ──────────────────────────────────────────────────────────────
// (b) TRANSITION BOUNDARY — the latch hand-off
//
// AI: signal N drives the REAL VirtualHookEngine through genuine
// virtual rounds to AUTHORIZED; N is discarded with zero buys and
// the VH runtime deactivates; signal N+1 enters UNLATCHED and buys
// exactly once via the real proposal → buy → settlement pipeline.
// ──────────────────────────────────────────────────────────────

describe('(b) TRANSITION BOUNDARY — latched AUTHORIZED discards N, unlatched N+1 buys once', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('AI engine: real VH round AUTHORIZED → N discarded → N+1 buys exactly once', async () => {
        // Real virtual rounds: 2 winning rounds (digit 6 > prediction 5)
        // reach minWins=2 ⇒ genuine AUTHORIZED from the real engine.
        const engine = new TradingEngine({
            ...baseConfig,
            vhConfig: { enabled: true, maxSteps: 2, minWins: 2, settlementTimeoutMs: 400 },
        });

        // ── Wire the real proposal → buy → settlement round-trip ──
        const handlers: Record<string, Array<(msg: any) => void>> = {};
        (EventBus.on as jest.Mock).mockImplementation((event: string, cb: (msg: any) => void) => {
            (handlers[event] = handlers[event] ?? []).push(cb);
            return () => {};
        });
        const deliver = (event: string, msg: any) => {
            (handlers[event] ?? []).slice().forEach(cb => cb(msg));
        };

        const buySendsByProposal: Array<{ buyReqId: number; proposalReqId: number }> = [];
        let lastProposalReqId = -1;
        let nextContractId = 91000;
        (WebSocketManager.send as jest.Mock).mockImplementation((payload: any) => {
            if (payload?.proposal) {
                lastProposalReqId = payload.req_id;
                setTimeout(() => deliver('proposal', {
                    req_id: payload.req_id,
                    proposal: { id: `prop-${payload.req_id}` },
                }), 0);
            } else if (payload && 'buy' in payload) {
                const contractId = ++nextContractId;
                buySendsByProposal.push({ buyReqId: payload.req_id, proposalReqId: lastProposalReqId });
                setTimeout(() => deliver('buy', {
                    req_id: payload.req_id,
                    buy: {
                        contract_id: contractId,
                        transaction_id: contractId + 1,
                        buy_price: payload.price,
                        payout: payload.price * 1.9,
                        longcode: 'spec-longcode',
                        shortcode: 'spec-shortcode',
                        start_time: 1_700_000_000,
                    },
                }), 0);
            } else if (payload?.proposal_open_contract) {
                setTimeout(() => deliver('proposal_open_contract', {
                    proposal_open_contract: {
                        contract_id: payload.contract_id,
                        is_sold: true,
                        profit: 0.9,
                        buy_price: 1,
                        sell_price: 1.9,
                        exit_tick: 1006.7,
                        exit_spot: 1006.7,
                        currency: 'USD',
                    },
                }), 0);
            }
        });

        await engine.start();
        expect((engine as any)._vhActive).toBe(true);
        const vh = getVHEngine(engine)!;

        // ── Signal N: enters while VH active ⇒ latched ──
        const firstResult = await (engine as any)._executeTrade('DIGITOVER', '5', 1);
        expect(firstResult).toEqual({ won: true, profit: 0.9, exitDigit: 7 });

        // N ran REAL virtual rounds (policy saw 2 wins in 2 rounds).
        const statusAfterN = vh.getStatus();
        expect(statusAfterN.steps).toBe(2);
        expect(statusAfterN.wins).toBe(2);
        // Each settled virtual round flowed through the recording pipeline.
        expect(((getVHTransactionPipeline() as any).process) as jest.Mock).toHaveBeenCalledTimes(2);

        // N is promoted into the real pipeline once; VH runtime deactivates.
        expect(buySendsByProposal).toHaveLength(1);
        expect(getBuySends()).toHaveLength(1);
        expect((engine as any)._vhActive).toBe(false);
        expect(vh.isEnabled()).toBe(false);

        // ── Signal N+1: enters UNLATCHED ⇒ existing real path ──
        const result = await (engine as any)._executeTrade('DIGITOVER', '5', 1);
        expect(result).toEqual({ won: true, profit: 0.9, exitDigit: 7 });

        // N+1 uses the now-unlatched real path, so there are two total buys.
        expect(buySendsByProposal).toHaveLength(2);
        expect(getBuySends()).toHaveLength(2);
        expect(statusAfterN.steps).toBe(vh.getStatus().steps); // no new VH rounds

        // ── No late replay: signal N still produces only one buy ──
        await sleep(150);
        expect(buySendsByProposal).toHaveLength(2);
        expect(getBuySends()).toHaveLength(2);

        engine.stop();
    });

    test('XML engine: AUTHORIZED promotes latched purchase N; unlatched N+1 buys once', async () => {
        const bot = makeXmlBot();

        // Enable VH via the REAL ActiveContract path.
        bot.setVirtualHookEnabled(true);
        expect(bot._vhRuntimeActive).toBe(true);
        const vh = bot.virtualHookEngine;
        expect(vh).not.toBeNull();

        // Signal N: first gate consultation completes the virtual round
        // and returns AUTHORIZED.
        let gateCalls = 0;
        vh.startImpl = async () => {
            gateCalls++;
            return AUTHORIZED_RESULT;
        };

        await bot.purchase('DIGITOVER');

        // Latched purchase N: one real buy + runtime deactivated.
        expect(gateCalls).toBe(1);
        expect(bot._executeRealPurchase).toHaveBeenCalledTimes(1);
        expect(bot._executeRealPurchase).toHaveBeenCalledWith('DIGITOVER', 'DIGITOVER');
        expect(bot._vhRuntimeActive).toBe(false);
        expect(vh.cfg.enabled).toBe(false);

        // Signal N+1: unlatched ⇒ straight to the real pipeline.
        await bot.purchase('DIGITOVER');
        expect(bot._executeRealPurchase).toHaveBeenCalledTimes(2);
        expect(bot._executeRealPurchase).toHaveBeenCalledWith('DIGITOVER', 'DIGITOVER');
        // Gate never consulted for the unlatched purchase.
        expect(gateCalls).toBe(1);

        // Signal N is not replayed — the second call is the explicit N+1 signal.
        await bot.purchase('DIGITOVER');
        expect(bot._executeRealPurchase).toHaveBeenCalledTimes(3);
        expect(gateCalls).toBe(1);
    });
});

// ──────────────────────────────────────────────────────────────
// (c) MID-ROUND DISABLE — the latch outlives a manual disable
//
// The mode is determined at SIGNAL ENTRY. Disabling VH while N's
// virtual round is still running can never promote N to a real buy.
// ──────────────────────────────────────────────────────────────

describe('(c) MID-ROUND DISABLE — latch semantics survive a disable during round N', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('AI engine: runtime mode flipped during N’s round ⇒ still ZERO buys for N', async () => {
        const engine = new TradingEngine({
            ...baseConfig,
            vhConfig: { enabled: true, maxSteps: 2, minWins: 2, settlementTimeoutMs: 600 },
        });
        await engine.start();
        expect((engine as any)._vhActive).toBe(true);

        const realSpy = jest.fn().mockResolvedValue({ won: true, profit: 0.9, exitDigit: 5 });
        (engine as any)._executeRealTrade = realSpy;

        const vh = getVHEngine(engine)!;
        const tickObserver = (vh as any)._tickObserver;

        // During round N, flip the runtime mode exactly the way the
        // manual disable path does (setVHEnabled(false) writes
        // _vhActive). The PUBLIC toggle itself is rejected while the
        // VH engine is actively evaluating — captured for assertion.
        let flipped = false;
        let publicToggleDuringRound: boolean | null = null;
        const originalStart = tickObserver.start.bind(tickObserver);
        tickObserver.start = (symbol: string, onTick: (t: any) => void) => {
            if (!flipped) {
                flipped = true;
                setTimeout(() => {
                    // Core of the manual disable: runtime mode flag off.
                    (engine as any)._vhActive = false;
                    // Public API while the engine evaluates ⇒ rejected.
                    publicToggleDuringRound = engine.setVHEnabled(false);
                }, 150);
            }
            return originalStart(symbol, onTick);
        };

        // Signal N — latched at entry (VH active). Settles AUTHORIZED
        // AFTER the mid-round disable: the latch, not the mutable flag,
        // governs ⇒ discarded with zero buys.
        await expect((engine as any)._executeTrade('DIGITOVER', '5', 1))
            .resolves.toEqual({ won: true, profit: 0.9, exitDigit: 5 });

        expect(flipped).toBe(true);
        expect((engine as any)._vhActive).toBe(false);
        // The public manual path could not interfere mid-round.
        expect(publicToggleDuringRound).toBe(false);
        // Latch proof: mode was OFF at settlement time yet N still
        // reached the real path exactly once.
        expect(realSpy).toHaveBeenCalledTimes(1);
        expect(getBuySends()).toHaveLength(0);

        // Post-round the manual disable path applies cleanly again.
        expect(engine.setVHEnabled(false)).toBe(true);
        expect((engine as any)._vhActive).toBe(false);

        engine.stop();
    });

    test('XML engine: setVirtualHookEnabled(false) during N’s gate ⇒ N still discarded', async () => {
        const bot = makeXmlBot();
        bot.setVirtualHookEnabled(true);
        expect(bot._vhRuntimeActive).toBe(true);

        const vh = bot.virtualHookEngine;
        // Mid-gate: the REAL manual disable runs while purchase N is
        // inside the VH gate — then the gate resolves AUTHORIZED.
        vh.startImpl = async () => {
            await sleep(10);
            bot.setVirtualHookEnabled(false); // manual disable mid-round
            return AUTHORIZED_RESULT;
        };

        await bot.purchase('DIGITOVER');

        // Latch proof: _vhRuntimeActive was false at decision time,
        // yet N still reached the real purchase path once.
        expect(bot._vhRuntimeActive).toBe(false);
        expect(bot._executeRealPurchase).toHaveBeenCalledTimes(1);
        expect(bot._purchaseInProgress).toBe(false);

        // Next purchase enters unlatched and uses the real pipeline.
        await bot.purchase('DIGITOVER');
        expect(bot._executeRealPurchase).toHaveBeenCalledTimes(2);
    });
});

// ──────────────────────────────────────────────────────────────
// (d) + (e) — REAL pipeline sections
//
// These sections bypass the file-level mocks for the recording
// layer only: sharedExitDigitHistory and VHRuntime are loaded as
// REAL modules inside jest.isolateModules so dedupe, commit wiring,
// Summary/Journal absorption and real-store isolation are verified
// against production code.
// ──────────────────────────────────────────────────────────────

function requireRealRecordingModules(): any {
    // jest.doMock cannot override the file-level jest.mock registrations,
    // so the two recording modules are UNMOCKED and loaded REAL inside a
    // fresh isolateModules registry. All file-level infra mocks still
    // apply inside the isolate (mock registry is not isolated).
    jest.unmock('../sharedExitDigitHistory');
    jest.unmock('../virtualHook/VHRuntime');

    let mods: any = {};
    jest.isolateModules(() => {
        mods = {
            history: jest.requireActual('../sharedExitDigitHistory'),
            vhRuntime: jest.requireActual('../virtualHook/VHRuntime'),
            engineMod: jest.requireActual('../tradingEngine'),
            contractMod: jest.requireActual('../virtualHook/VirtualContract'),
            summaryMod: jest.requireActual('../virtualHook/SummaryStore'),
            journalMod: jest.requireActual('../virtualHook/VHJournalStore'),
        };
    });
    return mods;
}

function makeSettledVirtualContract(
    contractMod: any,
    runId: string,
    won: boolean,
    exitTick: number,
    settledAt: number
): any {
    const candidate = {
        signalId: `${runId}-signal`,
        source: 'ai',
        contractType: 'DIGITOVER',
        symbol: 'R_10',
        realStake: 1.0,
        duration: 1,
        durationUnit: 't',
        currency: 'USD',
        basis: 'stake',
        prediction: 5,
        tradeParams: {},
        generatedAt: settledAt,
    };
    let contract = contractMod.VirtualContractFactory.create(runId, 0, candidate, `prop-${runId}`, 0.5, 1.0);
    contract = contractMod.VirtualContractFactory.recordEntry(contract, 1005.4);
    contract = contractMod.VirtualContractFactory.settle(
        contract,
        { won, source: 'api', rawContract: null, settledAt },
        exitTick
    );
    return contract;
}

// ──────────────────────────────────────────────────────────────
// (d) TICK OBSERVATION ISOLATION
// ──────────────────────────────────────────────────────────────

describe('(d) TICK OBSERVATION ISOLATION — live ticks never append; one commit appends once', () => {
    test('monitoring ticks append 0; one VH settlement appends 1; duplicate stays 1', async () => {
        const mods = requireRealRecordingModules();

        const engine = new mods.engineMod.TradingEngine({
            ...baseConfig,
            vhConfig: { enabled: false },
        });
        await engine.start();

        // ── N live ticks through handleTick in monitoring state ──
        const TICKS = 12;
        for (let i = 0; i < TICKS; i++) {
            (engine as any).handleTick({ epoch: 1_700_000_000 + i, quote: 1000.1 + i });
        }
        // Observation-only: the shared exit-digit history stays EMPTY.
        expect(mods.history.getExitDigitHistory()).toHaveLength(0);

        // ── ONE VH settlement through the real commit pipeline ──
        const pipeline = mods.vhRuntime.getVHTransactionPipeline();
        const winContract = makeSettledVirtualContract(
            mods.contractMod, 'run-spec-d', true, 1006.7, Date.now()
        );
        const first = await pipeline.process(winContract);
        expect(first.appended).toBe(true);

        expect(mods.history.getExitDigitHistory()).toHaveLength(1);
        const entry = mods.history.getExitDigitHistory()[0];
        expect(entry.digit).toBe(7);          // exit tick 1006.7 → digit 7
        expect(entry.source).toBe('VH');
        expect(entry.won).toBe(true);
        expect(entry.contractId).toBe(winContract.contractId);

        // ── Re-commit the SAME contractId ⇒ bounded dedupe ──
        const second = await pipeline.process(winContract);
        expect(second.appended).toBe(false);
        expect(mods.history.getExitDigitHistory()).toHaveLength(1);
        expect(mods.vhRuntime.getVHStore().count).toBe(1);

        engine.stop();
    });
});

// ──────────────────────────────────────────────────────────────
// (e) ACCOUNTING ISOLATION
// ──────────────────────────────────────────────────────────────

describe('(e) ACCOUNTING ISOLATION — virtual outcomes never touch real accounting', () => {
    test('virtual win + loss hit VH stores; real store/summary/engine P&L unchanged', async () => {
        // Same unmock strategy as (d): real recording modules inside a
        // fresh isolate registry; file-level infra mocks still apply.
        jest.unmock('../sharedExitDigitHistory');
        jest.unmock('../virtualHook/VHRuntime');

        let mods: any = {};
        jest.isolateModules(() => {
            // Real Transactions panel store dependencies.
            jest.doMock('@/components/shared', () => ({
                formatDate: (v: any) => String(v ?? ''),
                isEnded: (c: any) => Boolean(
                    (c?.status && c.status !== 'open') ||
                    c?.is_sold || c?.is_expired || c?.is_settleable
                ),
            }));

            mods = {
                history: jest.requireActual('../sharedExitDigitHistory'),
                vhRuntime: jest.requireActual('../virtualHook/VHRuntime'),
                engineMod: jest.requireActual('../tradingEngine'),
                contractMod: jest.requireActual('../virtualHook/VirtualContract'),
                summaryMod: jest.requireActual('../virtualHook/SummaryStore'),
                journalMod: jest.requireActual('../virtualHook/VHJournalStore'),
                realTransactionsStore: jest.requireActual('../../stores/transactions-store').default,
            };
        });

        // ── REAL transactions store with one genuine real row ──
        const core: any = { client: { loginid: 'CR900001' } };
        const rootStore: any = { run_panel: { run_id: 'run-real-e' } };
        const realStore = new mods.realTransactionsStore(rootStore, core);

        const realContract: any = {
            contract_id: 777001,
            transaction_ids: { buy: 555001 },
            is_sold: true,
            status: 'won',
            profit: 0.95,
            buy_price: 1,
            payout: 1.95,
            bid_price: 1.95,
            exit_tick: 1006.7,
            date_start: 1_700_000_000,
            currency: 'USD',
        };
        realStore.pushTransaction(realContract);

        const realRowsBefore = realStore.transactions.length;
        const realStatsBefore = JSON.stringify(realStore.statistics);
        expect(realRowsBefore).toBe(1);

        // ── Engine accounting baseline (VH disabled session) ──
        const engine = new mods.engineMod.TradingEngine({
            ...baseConfig,
            vhConfig: { enabled: false },
        });
        const profitBefore = (engine as any).profit;
        const tradeCountBefore = (engine as any).tradeCount;

        // ── VH Summary/Journal observers on the shared VH store ──
        // Pipeline first — it materializes the shared store lazily.
        const pipeline = mods.vhRuntime.getVHTransactionPipeline();
        const vhStore = mods.vhRuntime.getVHStore();
        expect(vhStore).not.toBeNull();
        const summary = new mods.summaryMod.SummaryStore();
        const journal = new mods.journalMod.VHJournalStore();
        vhStore.subscribe((r: any) => summary.onTransactionCommitted(r));
        vhStore.subscribe((r: any) => journal.onTransactionCommitted(r));

        // ── Commit one virtual WIN and one virtual LOSS ──
        const now = Date.now();
        const win = makeSettledVirtualContract(mods.contractMod, 'run-spec-e1', true, 1006.7, now);
        const loss = makeSettledVirtualContract(mods.contractMod, 'run-spec-e2', false, 1003.2, now + 1);
        expect((await pipeline.process(win)).appended).toBe(true);
        expect((await pipeline.process(loss)).appended).toBe(true);

        // ── VH side absorbed both outcomes ──
        expect(vhStore.count).toBe(2);
        const vhSummary = summary.getSummary();
        expect(vhSummary.totalTrades).toBe(2);
        expect(vhSummary.wins).toBe(1);
        expect(vhSummary.losses).toBe(1);
        expect(vhSummary.grossProfit).toBe(1.0);   // +virtualStake on win
        expect(vhSummary.grossLoss).toBe(1.0);     // -virtualStake on loss
        expect(vhSummary.netProfit).toBe(0);
        expect(journal.getEntries()).toHaveLength(2);

        // ── REAL side untouched ──
        expect(realStore.transactions.length).toBe(realRowsBefore);
        expect(JSON.stringify(realStore.statistics)).toBe(realStatsBefore);
        expect((engine as any).profit).toBe(profitBefore);
        expect((engine as any).tradeCount).toBe(tradeCountBefore);
        // Exit-digit history carries ONLY the 2 VH digits + 1 REAL digit —
        // no virtual loss/win ever leaked into real accounting views.
        const history = mods.history.getExitDigitHistory();
        expect(history.filter((e: any) => e.source === 'VH')).toHaveLength(2);
        expect(history.filter((e: any) => e.source === 'REAL')).toHaveLength(1);
    });
});
