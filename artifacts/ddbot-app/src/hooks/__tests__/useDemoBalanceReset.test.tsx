import { renderHook, act } from '@testing-library/react';
import { useDemoBalanceReset } from '../useDemoBalanceReset';

jest.mock('@/utils/demo-balance-reset', () => ({
    resetDemoBalance: jest.fn(),
}));

import { resetDemoBalance } from '@/utils/demo-balance-reset';

const resetMock = resetDemoBalance as jest.Mock;

describe('useDemoBalanceReset', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('transitions loading state and returns true on success', async () => {
        let resolveReset!: () => void;
        resetMock.mockImplementation(() => new Promise<void>(resolve => (resolveReset = resolve)));

        const { result } = renderHook(() => useDemoBalanceReset());
        let done = false;
        let promise: Promise<boolean>;

        act(() => {
            promise = result.current.reset('VRTC1');
            promise.then(value => (done = value));
        });

        expect(result.current.is_resetting).toBe(true);

        await act(async () => {
            resolveReset();
            await promise;
        });

        expect(done).toBe(true);
        expect(result.current.is_resetting).toBe(false);
    });

    it('ignores duplicate submissions while a reset is in-flight', async () => {
        let resolveReset!: () => void;
        resetMock.mockImplementation(() => new Promise<void>(resolve => (resolveReset = resolve)));

        const { result } = renderHook(() => useDemoBalanceReset());
        let second: boolean | undefined;

        act(() => {
            void result.current.reset('VRTC1');
        });

        await act(async () => {
            second = await result.current.reset('VRTC1');
        });

        expect(second).toBe(false);
        expect(resetMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveReset();
        });
    });

    it('captures the error message on failure', async () => {
        resetMock.mockRejectedValue(new Error('Only demo accounts can have their balance reset'));

        const { result } = renderHook(() => useDemoBalanceReset());
        let ok: boolean | undefined;

        await act(async () => {
            ok = await result.current.reset('CR1');
        });

        expect(ok).toBe(false);
        expect(result.current.error).toBe('Only demo accounts can have their balance reset');
    });
});
