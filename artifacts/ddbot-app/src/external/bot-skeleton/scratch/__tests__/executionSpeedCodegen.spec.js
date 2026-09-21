/**
 * Execution-speed codegen guard (DBot.generateCode in ../dbot.js).
 *
 * FAST makes the tick epoch the unit of work for the before-purchase body, so a
 * body evaluation can never happen twice for one epoch:
 *
 *     while (watch('before')) {
 *         if (BinaryBotPrivateTickAnalysis()) { BinaryBotPrivateRun(BinaryBotPrivateBeforePurchase); }
 *     }
 *
 * BinaryBotPrivateTickAnalysis() returns true only when it analysed a NEW epoch.
 * NORMAL must keep generating exactly the original loop, byte for byte, and the
 * analysis function itself must be identical in both modes.
 *
 * The heavy scratch dependencies are mocked: this suite only exercises the
 * template that is handed to the interpreter.
 */
jest.mock('../blockly', () => ({ loadBlockly: jest.fn() }));
jest.mock('../dbot-store', () => ({ __esModule: true, default: {} }));
jest.mock('../utils', () => ({
    isAllRequiredBlocksEnabled: jest.fn(() => true),
    updateDisabledBlocks: jest.fn(),
    validateErrorOnBlockDelete: jest.fn(() => false),
}));
jest.mock('../accumulators-proposal-handler', () => ({ forgetAccumulatorsProposalRequest: jest.fn() }));
jest.mock('../../constants/config', () => ({ config: jest.fn(() => ({ lists: { NOTIFICATION_SOUND: [['silent', 'silent']] } })) }));
jest.mock('../../utils', () => ({
    compareXml: jest.fn(),
    observer: { emit: jest.fn(), register: jest.fn(), unregister: jest.fn(), unregisterAll: jest.fn() },
}));
jest.mock('../../utils/local-storage', () => ({
    getSavedWorkspaces: jest.fn(() => Promise.resolve([])),
    saveWorkspaceToRecent: jest.fn(),
}));
jest.mock('../../utils/workspace', () => ({ isDbotRTL: jest.fn(() => false) }));
jest.mock('../../services/api/api-base', () => ({
    api_base: { api: null, is_stopping: false, setIsRunning: jest.fn(), toggleRunButton: jest.fn() },
}));
jest.mock('../../services/api/api-helpers', () => ({ __esModule: true, default: { instance: {} } }));
jest.mock('../../services/tradeEngine/utils/interpreter', () => ({ __esModule: true, default: jest.fn(() => ({})) }));

import DBot from '../dbot';
import { executionMode } from '../../services/tradeEngine/utils/execution-mode';

const NORMAL_LOOP_BODY =
    "BinaryBotPrivateTickAnalysis();\n                    BinaryBotPrivateRun(BinaryBotPrivateBeforePurchase);";

const generate = () => {
    DBot.workspace = {};

    return DBot.generateCode();
};

const analysisFunction = code =>
    code.slice(
        code.indexOf('function BinaryBotPrivateTickAnalysis()'),
        code.indexOf('var BinaryBotPrivateLimitations')
    );

beforeAll(() => {
    // generateCode only needs the JS generator entry point.
    global.window.Blockly = { JavaScript: { javascriptGenerator: { workspaceToCode: () => '' } } };
});

beforeEach(() => {
    executionMode.reset();
});

describe('execution speed codegen guard', () => {
    test('NORMAL generates the original before-purchase loop', () => {
        const code = generate();

        expect(code).toContain(NORMAL_LOOP_BODY);
        expect(code).not.toContain('if (BinaryBotPrivateTickAnalysis()) {');
        // NORMAL must not reference the FAST-only historical-data guard either.
        expect(code).not.toContain('isTickDataUnavailable');
        expect(code).not.toContain('BinaryBotPrivateTickAnalysisIfDataAvailable');
    });

    test('FAST runs the before-purchase body only for a newly analysed epoch with available data', () => {
        executionMode.set('FAST');
        const code = generate();

        expect(code).toContain("while (watch('before')) {");
        expect(code).toContain('if (BinaryBotPrivateTickAnalysisIfDataAvailable()) {');
        expect(code).toContain('BinaryBotPrivateRun(BinaryBotPrivateBeforePurchase);');
        expect(code).not.toContain(NORMAL_LOOP_BODY);
    });

    test('FAST never runs the tick analysis for an epoch whose own data is unavailable', () => {
        executionMode.set('FAST');
        const code = generate();

        // The guard runs BEFORE the analysis (the engine resolves availability).
        expect(code).toContain('function BinaryBotPrivateTickAnalysisIfDataAvailable() {');
        expect(code).toContain('if (Bot.isTickDataUnavailable()) return false;');
        expect(code).toContain('return BinaryBotPrivateTickAnalysis();');
        // Every tick-analysis site goes through the guard in FAST ...
        expect(code).not.toMatch(/^\s+BinaryBotPrivateTickAnalysis\(\);/m);
        // ... while the during-purchase body itself is unchanged (an open contract is
        // still managed on every iteration).
        expect(code).toContain(
            'BinaryBotPrivateTickAnalysisIfDataAvailable();\n                    BinaryBotPrivateRun(BinaryBotPrivateDuringPurchase);'
        );
    });

    test('the tick analysis function is identical in both modes and reports new epochs', () => {
        const normal_code = generate();
        executionMode.set('FAST');
        const fast_code = generate();

        expect(analysisFunction(fast_code)).toBe(analysisFunction(normal_code));
        expect(analysisFunction(normal_code)).toContain('return false;');
        expect(analysisFunction(normal_code)).toContain('return true;');
    });
});