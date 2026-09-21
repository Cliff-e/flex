/**
 * Stop safety for the FAST tick stream.
 *
 * FAST keeps a per-engine FIFO queue of received tick epochs. Interpreter
 * teardown (Stop / terminate) must clear it, so a stopped session can never
 * replay queued ticks after it has been torn down.
 *
 * The interpreter internals (Interface / TradeEngine / ticks service / JS
 * interpreter) are mocked: this suite asserts the teardown wiring only.
 */
const mockResetTickStream = jest.fn();

jest.mock('@deriv/js-interpreter', () => ({ __esModule: true, default: function MockJSInterpreter() {} }));

jest.mock('@/components/shared', () => ({ isMultiplierContract: jest.fn(() => false) }));

jest.mock('../../Interface', () => ({
    __esModule: true,
    default: () => ({
        tradeEngine: {
            resetTickStream: mockResetTickStream,
            isSold: true,
            data: { contract: {} },
        },
        observer: {},
        getInterface: () => ({}),
    }),
}));

jest.mock('../cliTools', () => ({
    createScope: () => ({
        observer: {
            register: jest.fn(),
            unregister: jest.fn(),
            unregisterAll: jest.fn(),
            emit: jest.fn(),
            getState: jest.fn(),
            setState: jest.fn(),
        },
        ticksService: { unsubscribeFromTicksService: jest.fn(() => Promise.resolve()) },
        stopped: false,
    }),
}));

jest.mock('../../../api/api-base', () => ({
    api_base: { api: { send: jest.fn() }, clearSubscriptions: jest.fn(), is_stopping: false },
}));

import Interpreter from '../interpreter';

describe('FAST tick stream is cleared on stop', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('terminateSession() drops the pending tick queue', async () => {
        const interpreter = Interpreter();

        // Harness check: the engine the interpreter tears down is the mocked one.
        expect(interpreter.bot.tradeEngine.resetTickStream).toBe(mockResetTickStream);

        await interpreter.terminateSession();

        expect(mockResetTickStream).toHaveBeenCalledTimes(1);
    });
});