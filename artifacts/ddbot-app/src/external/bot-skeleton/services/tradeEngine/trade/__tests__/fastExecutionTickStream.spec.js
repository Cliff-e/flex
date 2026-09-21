/**
 * FAST execution tick stream tests.
 *
 * watchScopeFast + the per-engine FIFO queue live in ../index.js, the per-tick
 * data view lives in ../Ticks.js, the mode + telemetry live in
 * ../utils/execution-mode.js.
 *
 * FAST is a LOSSLESS tick consumer. The acceptance criterion asserted here is:
 *
 *     unique live tick epochs received === unique tick epochs processed
 *
 * with zero silently dropped epochs, in arrival / epoch order, for a 1 second and
 * an about 2 second index cadence, when the interpreter is slower than the tick
 * interval (backlog) and when two XML engines run at the same time.
 *
 * The ticks are delivered through the REAL production tick path: watchTicks()
 * registers the genuine ticksService callback and deliverTick() feeds it exactly
 * what ticks_service hands over for one accepted (unique) live tick. Nothing is
 * fabricated inside the engine.
 *
 * Test 8 asserts NORMAL behaviour, so this suite also guards the untouched path.
 */

// '@/bot/...' has no jest moduleNameMapper entry, so the Virtual Hook modules that
// ActiveContract.js / Purchase.js import are mocked virtually (same pattern as
// src/bot/__tests__/VHSpecInvariants.test.ts).
jest.mock(
    '@/bot/virtualHook',
    () => ({
        VHDecision: { AUTHORIZED: 'AUTHORIZED', REJECTED: 'REJECTED', RETRY: 'RETRY', STOPPED: 'STOPPED' },
        VirtualHookEngine: class MockVirtualHookEngine {},
    }),
    { virtual: true }
);
jest.mock('@/bot/virtualHook/VHRuntime', () => ({ getVHTransactionPipeline: jest.fn() }), { virtual: true });
jest.mock('@/bot/virtualHook/adapters/XmlProposalAdapter', () => ({ XmlProposalAdapter: jest.fn() }), {
    virtual: true,
});
jest.mock('@/bot/virtualHook/adapters/XmlTickObserver', () => ({ XmlTickObserver: jest.fn() }), {
    virtual: true,
});

jest.mock('../../../api/api-base', () => ({
    api_base: {
        api: {
            send: jest.fn().mockResolvedValue({}),
            onMessage: () => ({ subscribe: () => ({ unsubscribe: jest.fn() }) }),
        },
        account_info: { loginid: 'VRTC0000' },
        pip_sizes: { R_100: 2, HZ100V: 2 },
        token: 'test-token',
        is_stopping: false,
        pushSubscription: jest.fn(),
        clearSubscriptions: jest.fn(),
        setIsRunning: jest.fn(),
        toggleRunButton: jest.fn(),
    },
}));

import TradeEngine from '../index';
import * as constants from '../state/constants';
import { api_base } from '../../../api/api-base';
import { executionMode, tickStreamInvariantHolds, tickStreamStats } from '../../utils/execution-mode';

const SYMBOL = 'R_100';

/**
 * Builds an engine wired to the real tick path:
 *   watchTicks() registers the production callback,
 *   deliverTick() feeds it one accepted live tick.
 */
const createHarness = symbol => {
    const harness = { symbol, ticks_list: [], tick_callback: null };

    const ticksService = {
        ticks: new Map(),
        pipSizes: { [symbol]: 2 },
        ticks_history_promise: null,
        request: jest.fn(() => Promise.resolve(harness.ticks_list)),
        monitor: jest.fn(options => {
            harness.tick_callback = options.callback;
            return Promise.resolve('listener-key');
        }),
        stopMonitor: jest.fn(() => Promise.resolve()),
    };

    harness.engine = new TradeEngine({
        observer: { emit: jest.fn(), register: jest.fn(), unregister: jest.fn(), unregisterAll: jest.fn() },
        ticksService,
        stopped: false,
    });
    harness.ticksService = ticksService;

    return harness;
};

const openBeforePurchase = engine => {
    engine.store.dispatch({ type: constants.START });
    engine.store.dispatch({ type: constants.PROPOSALS_READY });
};

/** One accepted live tick, delivered exactly as Ticks.watchTicks receives it. */
const deliverTick = (harness, epoch, quote = epoch / 1000) => {
    harness.ticks_list = [...harness.ticks_list, { epoch, quote }];
    harness.ticksService.ticks.set(harness.symbol, harness.ticks_list);
    harness.tick_callback(harness.ticks_list);
};

/** Resolves to pending while the promise under test has not settled yet. */
const waitState = promise => Promise.race([promise.then(() => 'resolved'), Promise.resolve('pending')]);

/**
 * One interpreter iteration: waits for an eligible tick, then reports the epoch
 * the XML logic observes through Bot.getLastTick(true).
 */
const runEvaluation = async harness => {
    const allowed = await harness.engine.watch('before');
    if (!allowed) return null;

    const tick = await harness.engine.getLastTick(true);
    return tick && tick.epoch;
};

const range = (start, count) => Array.from({ length: count }, (_, i) => start + i);

beforeEach(() => {
    executionMode.reset();
    jest.clearAllMocks();
});
describe('FAST tick stream is lossless', () => {
    test('1. one received tick is processed exactly once', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);
        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        deliverTick(h, 1000);

        expect(await runEvaluation(h)).toBe(1000);

        expect(h.engine.getTickStreamStats()).toMatchObject({
            received: 1,
            processed: 1,
            pending: 0,
            max_pending: 1,
            processing: 1000,
            dropped: 0,
            unavailable: 0,
        });
        expect(tickStreamInvariantHolds(h.engine.getTickStreamStats())).toBe(true);
    });

    test('2. ten rapidly received ticks are all processed, in order', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);
        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        range(2000, 10).forEach(epoch => deliverTick(h, epoch));

        const processed = [];
        for (let i = 0; i < 10; i++) processed.push(await runEvaluation(h));

        expect(processed).toEqual(range(2000, 10));
        expect(h.engine.getTickStreamStats()).toMatchObject({
            received: 10,
            processed: 10,
            pending: 0,
            dropped: 0,
        });
    });

    test('3. ticks arriving while an evaluation is busy are retained, not overwritten', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);
        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        deliverTick(h, 3000);

        // Tick 1 starts executing, then tick 2, 3 and 4 arrive while it is busy.
        const evaluation_1 = runEvaluation(h);
        deliverTick(h, 3001);
        deliverTick(h, 3002);
        deliverTick(h, 3003);

        // Tick 1 still evaluates its own data.
        expect(await evaluation_1).toBe(3000);

        // All three later ticks are still queued (nothing was replaced).
        expect(h.engine.getTickStreamStats()).toMatchObject({
            received: 4,
            processed: 1,
            pending: 3,
            max_pending: 3,
            dropped: 0,
        });

        expect(await runEvaluation(h)).toBe(3001);
        expect(await runEvaluation(h)).toBe(3002);
        expect(await runEvaluation(h)).toBe(3003);

        expect(h.engine.getTickStreamStats()).toMatchObject({
            received: 4,
            processed: 4,
            pending: 0,
            dropped: 0,
        });
    });

    test('4. a backlog is evaluated epoch by epoch (order preserved, no dedupe loss)', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);
        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        range(4000, 5).forEach(epoch => deliverTick(h, epoch));

        const processed = [];
        for (let i = 0; i < 5; i++) processed.push(await runEvaluation(h));

        // Every queued epoch is evaluated with ITS OWN tick data, which is what
        // makes the generated BinaryBotPrivateTickAnalysis() see a new epoch each
        // time instead of deduping the backlog away.
        expect(processed).toEqual(range(4000, 5));
        expect(new Set(processed).size).toBe(5);
    });

    test('5. duplicate delivery of the same epoch is processed only once', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);
        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        deliverTick(h, 5000);
        h.tick_callback(h.ticks_list); // duplicate delivery of the same epoch

        expect(h.engine.getTickStreamStats()).toMatchObject({ received: 1, pending: 1 });
        expect(await runEvaluation(h)).toBe(5000);

        h.tick_callback(h.ticks_list); // duplicate after processing
        expect(h.engine.getTickStreamStats()).toMatchObject({ received: 1, processed: 1, pending: 0 });

        await expect(waitState(h.engine.watch('before'))).resolves.toBe('pending');
    });

    test('6. two engines keep independent queues and cursors', async () => {
        executionMode.set('FAST');
        const a = createHarness(SYMBOL);
        const b = createHarness(SYMBOL);
        await a.engine.watchTicks(SYMBOL);
        await b.engine.watchTicks(SYMBOL);
        openBeforePurchase(a.engine);
        openBeforePurchase(b.engine);

        // Engine B is parked on its own watch ...
        const b_watch = b.engine.watch('before');
        await expect(waitState(b_watch)).resolves.toBe('pending');

        deliverTick(a, 6000);
        deliverTick(a, 6001);

        // ... and engine A ticks must not leak into B or consume a B tick.
        await expect(waitState(b_watch)).resolves.toBe('pending');
        expect(b.engine.getTickStreamStats()).toMatchObject({ received: 0, processed: 0, pending: 0 });

        expect(await runEvaluation(a)).toBe(6000);
        expect(await runEvaluation(a)).toBe(6001);

        // The same epoch on B is B own tick, consumed by B own cursor.
        deliverTick(b, 6000);
        await expect(b_watch).resolves.toBe(true);
        expect((await b.engine.getLastTick(true)).epoch).toBe(6000);

        expect(a.engine.getTickStreamStats()).toMatchObject({ received: 2, processed: 2, pending: 0 });
        expect(b.engine.getTickStreamStats()).toMatchObject({ received: 1, processed: 1, pending: 0 });
    });

    test('7. stop clears pending ticks and nothing is replayed afterwards', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);
        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        deliverTick(h, 7000);
        deliverTick(h, 7001);
        expect(h.engine.getTickStreamStats()).toMatchObject({ pending: 2 });

        // interpreter teardown (terminateSession -> tradeEngine.resetTickStream())
        h.engine.resetTickStream();

        // The two queued ticks are discarded by the terminal shutdown and are RECORDED
        // as such: never a silent loss, and never counted as processed.
        expect(h.engine.getTickStreamStats()).toMatchObject({
            received: 2,
            pending: 0,
            processing: null,
            processed: 0,
            dropped: 2,
            unavailable: 0,
        });
        expect(tickStreamInvariantHolds(h.engine.getTickStreamStats())).toBe(true);

        // Nothing can be consumed after the reset ...
        await expect(waitState(h.engine.watch('before'))).resolves.toBe('pending');

        // ... and a watch that is pending when the scope leaves BEFORE_PURCHASE exits
        // with false, exactly like the unchanged NORMAL path.
        const waiting = h.engine.watch('before');
        h.engine.store.dispatch({ type: constants.PURCHASE_SUCCESSFUL });
        await expect(waiting).resolves.toBe(false);
    });

    test('8. NORMAL keeps its existing behaviour (tick that arrives while busy is not consumed)', async () => {
        executionMode.set('NORMAL');
        const h = createHarness(SYMBOL);
        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        // NORMAL resolves on the tick that arrives while its watch is registered.
        const first_watch = h.engine.watch('before');
        deliverTick(h, 8000);
        await expect(first_watch).resolves.toBe(true);
        expect((await h.engine.getLastTick(true)).epoch).toBe(8000);

        // The tick that arrives while the body runs has no listener, so NORMAL drops it
        // and stays parked until the FOLLOWING tick - exactly the loss FAST removes.
        deliverTick(h, 8001);
        const pending_watch = h.engine.watch('before');
        await expect(waitState(pending_watch)).resolves.toBe('pending');

        deliverTick(h, 8002);
        await expect(pending_watch).resolves.toBe(true);
        expect((await h.engine.getLastTick(true)).epoch).toBe(8002);

        // NORMAL never records into the FAST stream.
        expect(h.engine.getTickStreamStats()).toMatchObject({ received: 0, processed: 0, pending: 0 });
    });
});

describe('FAST tick cadence (1s and ~2s indices)', () => {
    test('1 second cadence: received === processed for the whole window', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);
        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        const processed = [];
        for (let i = 0; i < 12; i++) {
            deliverTick(h, 10000 + i); // +1s tick
            processed.push(await runEvaluation(h));
        }

        expect(processed).toEqual(range(10000, 12));
        expect(h.engine.getTickStreamStats()).toMatchObject({
            received: 12,
            processed: 12,
            pending: 0,
            dropped: 0,
        });
        expect(tickStreamStats.received).toBe(tickStreamStats.processed);
    });

    test('about 2 second cadence: received === processed for the whole window', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);
        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        const processed = [];
        for (let i = 0; i < 12; i++) {
            deliverTick(h, 11000 + i * 2); // +2s tick
            processed.push(await runEvaluation(h));
        }

        expect(processed).toEqual(range(0, 12).map(i => 11000 + i * 2));
        expect(h.engine.getTickStreamStats()).toMatchObject({
            received: 12,
            processed: 12,
            pending: 0,
            dropped: 0,
        });
    });

    test('a tick received before the bot is ready is still processed (no extra tick needed)', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);
        await h.engine.watchTicks(SYMBOL);

        deliverTick(h, 12000); // arrives before trade options / proposals are ready

        h.engine.store.dispatch({ type: constants.START });
        const pending_watch = h.engine.watch('before');
        await expect(waitState(pending_watch)).resolves.toBe('pending');

        // Once proposals are ready the ALREADY QUEUED tick is consumed: the bot does
        // not wait for another tick and does not miss this one.
        h.engine.store.dispatch({ type: constants.PROPOSALS_READY });

        await expect(pending_watch).resolves.toBe(true);
        expect((await h.engine.getLastTick(true)).epoch).toBe(12000);
        expect(h.engine.getTickStreamStats()).toMatchObject({ received: 1, processed: 1, pending: 0 });
    });

    test('a sustained backlog is retained and reported, never dropped', async () => {
        executionMode.set('FAST');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            const h = createHarness(SYMBOL);
            await h.engine.watchTicks(SYMBOL);
            openBeforePurchase(h.engine);

            // The interpreter cannot keep up: 100 ticks pile up.
            range(13000, 100).forEach(epoch => deliverTick(h, epoch));

            expect(h.engine.getTickStreamStats()).toMatchObject({
                received: 100,
                processed: 0,
                pending: 100,
                max_pending: 100,
                dropped: 0,
            });

            // The backlog is reported instead of being trimmed.
            expect(warn).toHaveBeenCalled();
            expect(String(warn.mock.calls[0][0])).toContain('No tick is dropped');

            const processed = [];
            for (let i = 0; i < 100; i++) processed.push(await runEvaluation(h));

            expect(processed).toEqual(range(13000, 100));
            expect(h.engine.getTickStreamStats()).toMatchObject({
                received: 100,
                processed: 100,
                pending: 0,
                dropped: 0,
            });
            expect(tickStreamStats.received).toBe(tickStreamStats.processed);
        } finally {
            warn.mockRestore();
        }
    });
});

/**
 * Generated-loop-level driver.
 *
 * Mirrors the FAST branch of DBot.generateCode() 1:1 - including the
 * tick-analysis calls that run BETWEEN two watches (generated lines 349 and 362),
 * which is exactly where a tick-data read could jump ahead of the FIFO:
 *
 *   while (true) {
 *       BinaryBotPrivateTickAnalysis();                       // outer loop   (349)
 *       ...
 *       while (watch('before')) {
 *           if (BinaryBotPrivateTickAnalysis() && !Bot.isTickDataUnavailable()) {
 *               BinaryBotPrivateRun(BinaryBotPrivateBeforePurchase);
 *           }
 *       }
 *       while (watch('during')) { BinaryBotPrivateTickAnalysis(); ... }
 *       BinaryBotPrivateTickAnalysis();                       // after during (362)
 *       if (!BinaryBotPrivateRun(BinaryBotPrivateAfterPurchase)) break;
 *   }
 *
 * tickAnalysis() is the generated analysis function: it reads the last tick through
 * the REAL engine tick API (Bot.getLastTick(true) -> Ticks.getLastTick -> FAST view),
 * dedupes on the epoch and then runs the analysis blocks (recorded in `evaluations`).
 */
const createLoopDriver = harness => {
    const evaluations = [];
    let last_analysed_epoch = null;

    const tickAnalysis = async tag => {
        let current = await harness.engine.getLastTick(true);

        while (current === 'MarketIsClosed') {
            current = await harness.engine.getLastTick(true);
        }

        const epoch = current.epoch;

        if (epoch === last_analysed_epoch) {
            evaluations.push({ tag, epoch, evaluated: false });
            return false;
        }

        last_analysed_epoch = epoch;
        evaluations.push({ tag, epoch, evaluated: true });

        return true;
    };

    /** One `while (watch('before'))` iteration of the generated loop. */
    const beforeLoopIteration = async tag => {
        const allowed = await harness.engine.watch('before');

        if (!allowed) return null;

        const popped = harness.engine.getTickStreamStats().processing;

        // if (BinaryBotPrivateTickAnalysisIfDataAvailable()) { Run(BeforePurchase) }
        const unavailable = harness.engine.isTickDataUnavailable();
        const analysed = unavailable ? false : await tickAnalysis(tag);

        return { popped, analysed, ran_before_purchase: !unavailable && analysed };
    };

    return { evaluations, tickAnalysis, beforeLoopIteration };
};

/** Parks a before-watch, lets it exit BEFORE_PURCHASE without popping, then re-arms. */
const parkAndExitBeforePurchase = async engine => {
    const parked = engine.watch('before');

    engine.store.dispatch({ type: constants.PURCHASE_SUCCESSFUL });
    await parked;
    engine.store.dispatch({ type: constants.START });
};


describe('FAST generated-loop order (Finding 1: no non-FIFO evaluation)', () => {
    test('TickAnalysis() between two watches resolves against the FIFO head, never the newest live tick', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);

        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);
        const loop = createLoopDriver(h);

        // E100 is evaluated by a before-purchase iteration.
        deliverTick(h, 100);
        expect(await loop.beforeLoopIteration('before#1')).toMatchObject({
            popped: 100,
            analysed: true,
            ran_before_purchase: true,
        });

        // The before loop exits on the purchase and the engine parks with an empty
        // FIFO, so the cursor is released: nothing is in flight.
        await parkAndExitBeforePurchase(h.engine);
        expect(h.engine.getTickStreamStats()).toMatchObject({
            received: 1,
            processed: 1,
            pending: 0,
            processing: null,
        });

        // E101 and E102 arrive while the engine is between the two before-purchase
        // loops (AfterPurchase / Bot.start). Nothing pops them: both stay queued.
        deliverTick(h, 101);
        deliverTick(h, 102);
        expect(h.engine.getTickStreamStats()).toMatchObject({ received: 3, processed: 1, pending: 2 });

        // A raw tick-data read (what the tick analysis uses) resolves against the
        // FIFO head - never the newest live tick.
        expect((await h.engine.getLastTick(true)).epoch).toBe(101);

        // Non-FIFO tick analysis (generated line 349): E101, NOT the newest E102.
        expect(await loop.tickAnalysis('outer-loop')).toBe(true);
        expect(loop.evaluations[loop.evaluations.length - 1]).toMatchObject({
            tag: 'outer-loop',
            epoch: 101,
            evaluated: true,
        });

        // watch() -> E101. It was already evaluated exactly once, so it is not
        // evaluated a second time (and its before-purchase body is not re-run).
        expect(await loop.beforeLoopIteration('before#2')).toMatchObject({
            popped: 101,
            analysed: false,
            ran_before_purchase: false,
        });

        // watch() -> E102.
        expect(await loop.beforeLoopIteration('before#3')).toMatchObject({
            popped: 102,
            analysed: true,
            ran_before_purchase: true,
        });

        // Final evaluation sequence: E100 -> E101 -> E102, each exactly once, in order.
        const evaluated = loop.evaluations.filter(entry => entry.evaluated).map(entry => entry.epoch);
        expect(evaluated).toEqual([100, 101, 102]);

        // No duplicate of the newest epoch anywhere: without the FIFO-head pinning the
        // non-FIFO analysis at line 349 reads E102 first and the before-body reads it
        // again (two E102 entries, and 102 evaluated before 101).
        expect(loop.evaluations.filter(entry => entry.epoch === 102)).toHaveLength(1);

        // The FIFO iteration for E101 re-reads E101 (its own data) and correctly
        // dedupes: it neither re-evaluates nor jumps ahead to E102.
        expect(loop.evaluations[2]).toMatchObject({ tag: 'before#2', epoch: 101, evaluated: false });

        const stats = h.engine.getTickStreamStats();
        expect(stats).toMatchObject({ received: 3, processed: 3, pending: 0, dropped: 0, unavailable: 0 });
        expect(tickStreamInvariantHolds(stats)).toBe(true);
    });
});


describe('FAST data-integrity failure / safe-stop (history exhaustion)', () => {
    test('a queued epoch whose exact data left the history window stops FAST safely instead of draining into unavailable', async () => {
        executionMode.set('FAST');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const h = createHarness(SYMBOL);

            await h.engine.watchTicks(SYMBOL);
            openBeforePurchase(h.engine);

            // 1500 unique live ticks pile up while the interpreter cannot keep up.
            range(1, 1500).forEach(epoch => deliverTick(h, epoch));
            expect(h.engine.getTickStreamStats()).toMatchObject({ received: 1500, pending: 1500 });

            // The retained Deriv history window only keeps the newest 1000 ticks, so
            // the oldest queued epochs (1..500) have lost their exact data.
            h.ticks_list = h.ticks_list.slice(-1000);
            h.ticksService.ticks.set(SYMBOL, h.ticks_list);
            expect(h.ticks_list[0].epoch).toBe(501);

            // The oldest queued epoch (1) is popped, then evaluated against its OWN data:
            // its exact epoch is gone, so its data is unavailable.
            expect(await h.engine.watch('before')).toBe(true);
            expect(h.engine.getTickStreamStats()).toMatchObject({ processing: 1, received: 1500, processed: 0 });

            // The tick-data view exposes the OLDEST available entry - never the newest
            // live tick, which would silently evaluate a different epoch.
            expect((await h.engine.getLastTick(true)).epoch).toBe(501);

            // The generated FAST guard (BinaryBotPrivateTickAnalysisIfDataAvailable)
            // reports the exact epoch as unavailable BEFORE any tick analysis runs.
            expect(h.engine.isTickDataUnavailable()).toBe(true);

            // The engine entered the explicit integrity-failure / safe-stop state.
            const stats = h.engine.getTickStreamStats();
            expect(stats).toMatchObject({
                received: 1500,
                processed: 0, // epoch 1 was NOT evaluated ...
                pending: 1499, // ... the remaining backlog was NOT drained ...
                dropped: 0, // ... and it was NOT silently discarded either
                unavailable: 1, // only the affected epoch is dispositioned
                failed: true,
            });
            expect(stats.integrity_failure).toMatchObject({ epoch: 1, oldest_available_epoch: 501 });
            expect(stats.integrity_failure.backlog).toHaveLength(1499);
            expect(stats.integrity_failure.backlog[0]).toBe(2);
            expect(stats.integrity_failure.backlog[stats.integrity_failure.backlog.length - 1]).toBe(1500);
            expect(tickStreamInvariantHolds(stats)).toBe(true);

            // Telemetry identifies the integrity failure, the affected epoch and the
            // remaining backlog, and is distinguishable from a normal Stop/teardown.
            const failure_log = error.mock.calls
                .map(call => String(call[0]))
                .find(text => text.includes('DATA INTEGRITY FAILURE'));
            expect(failure_log).toBeDefined();
            expect(failure_log).toContain('epoch 1');
            expect(failure_log).toContain('1499 queued tick(s) left unprocessed');
            expect(warn.mock.calls.some(call => String(call[0]).includes('tick data unavailable'))).toBe(true);

            // SAFE-STOP: no further epoch is popped or evaluated, so the run stops.
            await expect(h.engine.watch('before')).resolves.toBe(false);
            const stopped = h.engine.getTickStreamStats();
            expect(stopped).toMatchObject({
                received: 1500,
                processed: 0,
                pending: 1499,
                dropped: 0,
                unavailable: 1,
                failed: true,
            });
            expect(stopped.processing).toBe(1); // the next queued epoch (2) was never popped
            expect(tickStreamInvariantHolds(stopped)).toBe(true);

            // Reported exactly once, even when the guard is consulted again.
            expect(h.engine.isTickDataUnavailable()).toBe(true);
            expect(error.mock.calls.filter(call => String(call[0]).includes('DATA INTEGRITY FAILURE'))).toHaveLength(1);

            // No purchase is generated from substituted data: the tick analysis (and with
            // it the before-purchase body) never ran, so no buy request was ever sent.
            expect(
                api_base.api.send.mock.calls.some(args => args[0] && Object.prototype.hasOwnProperty.call(args[0], 'buy'))
            ).toBe(false);

            // A teardown after the failure keeps the failure identifiable (never rewritten
            // as a normal Stop): the record survives resetTickStream.
            h.engine.resetTickStream();
            const after_reset = h.engine.getTickStreamStats();
            expect(after_reset.failed).toBe(true);
            expect(after_reset.integrity_failure).toMatchObject({ epoch: 1, oldest_available_epoch: 501 });
            expect(after_reset.unavailable).toBe(1);
            expect(tickStreamInvariantHolds(after_reset)).toBe(true);
        } finally {
            warn.mockRestore();
            error.mockRestore();
        }
    });

    test('NORMAL is unaffected: no FAST queue, guard or safe-stop is ever entered', async () => {
        executionMode.set('NORMAL');
        const h = createHarness(SYMBOL);

        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        range(1, 1500).forEach(epoch => deliverTick(h, epoch));

        // NORMAL never records a FAST epoch and never enters the availability guard.
        expect(h.engine.getTickStreamStats()).toMatchObject({
            received: 0,
            processed: 0,
            pending: 0,
            unavailable: 0,
            failed: false,
            integrity_failure: null,
        });
        expect(h.engine.isTickDataUnavailable()).toBe(false);
    });
});


describe('FAST telemetry integrity (Finding 3)', () => {
    test('a popped epoch is not "processed" until its own data is actually served', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);

        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        deliverTick(h, 30000);
        deliverTick(h, 30001);

        // watch() pops E30000 ... nothing has been evaluated yet.
        await expect(h.engine.watch('before')).resolves.toBe(true);
        expect(h.engine.getTickStreamStats()).toMatchObject({
            received: 2,
            processed: 0,
            pending: 2,
            processing: 30000,
        });
        expect(tickStreamInvariantHolds(h.engine.getTickStreamStats())).toBe(true);

        // ... and its own data is served by the tick analysis.
        expect((await h.engine.getLastTick(true)).epoch).toBe(30000);
        expect(h.engine.getTickStreamStats()).toMatchObject({ received: 2, processed: 1, pending: 1 });

        // The next iteration pops E30001 and is aborted before reading its tick (Stop).
        await expect(h.engine.watch('before')).resolves.toBe(true);
        expect(h.engine.getTickStreamStats()).toMatchObject({ processing: 30001, processed: 1, pending: 1 });

        h.engine.resetTickStream();

        const stats = h.engine.getTickStreamStats();
        expect(stats).toMatchObject({ received: 2, processed: 1, pending: 0, dropped: 1, unavailable: 0 });
        expect(tickStreamInvariantHolds(stats)).toBe(true);
    });

    test('Stop with pending ticks records the terminal disposition instead of reporting success', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);

        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        range(20000, 5).forEach(epoch => deliverTick(h, epoch));
        expect(await runEvaluation(h)).toBe(20000);
        expect(await runEvaluation(h)).toBe(20001);
        expect(h.engine.getTickStreamStats()).toMatchObject({ received: 5, processed: 2, pending: 3, dropped: 0 });

        // Stop -> interpreter teardown -> tradeEngine.resetTickStream()
        h.engine.resetTickStream();

        const stats = h.engine.getTickStreamStats();
        expect(stats).toMatchObject({
            received: 5,
            processed: 2,
            pending: 0,
            processing: null,
            dropped: 3,
            unavailable: 0,
        });
        expect(stats.processed).not.toBe(stats.received);
        expect(tickStreamInvariantHolds(stats)).toBe(true);
        expect(tickStreamStats.dropped).toBe(3);
    });

    test('the accounting invariant holds across push / pop / serve / duplicate / stop', async () => {
        executionMode.set('FAST');
        const h = createHarness(SYMBOL);

        await h.engine.watchTicks(SYMBOL);
        openBeforePurchase(h.engine);

        const invariant = () => tickStreamInvariantHolds(h.engine.getTickStreamStats());

        expect(invariant()).toBe(true);

        deliverTick(h, 40000);
        expect(invariant()).toBe(true);

        h.tick_callback(h.ticks_list); // duplicate delivery: never received twice
        expect(h.engine.getTickStreamStats()).toMatchObject({ received: 1 });
        expect(invariant()).toBe(true);

        expect(await runEvaluation(h)).toBe(40000);
        expect(invariant()).toBe(true);

        deliverTick(h, 40001);
        deliverTick(h, 40002);
        expect(invariant()).toBe(true);

        // One more pop, left unread (in flight) before the terminal shutdown.
        await expect(h.engine.watch('before')).resolves.toBe(true);
        expect(h.engine.getTickStreamStats()).toMatchObject({ processing: 40001, processed: 1, pending: 2 });
        expect(invariant()).toBe(true);

        h.engine.resetTickStream();

        expect(h.engine.getTickStreamStats()).toMatchObject({
            received: 3,
            processed: 1,
            pending: 0,
            dropped: 2,
            unavailable: 0,
        });
        expect(invariant()).toBe(true);
    });
});
