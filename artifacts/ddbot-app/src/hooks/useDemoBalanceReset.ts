import { useCallback, useRef, useState } from 'react';
import { resetDemoBalance } from '@/utils/demo-balance-reset';

/**
 * Wraps demo-balance reset with loading state and duplicate-submit protection.
 * The in-flight ref guarantees a second click during the reset is ignored.
 */
export const useDemoBalanceReset = () => {
    const [is_resetting, setIsResetting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inFlight = useRef(false);

    const reset = useCallback(async (accountId: string): Promise<boolean> => {
        if (inFlight.current) return false;
        inFlight.current = true;
        setIsResetting(true);
        setError(null);
        try {
            await resetDemoBalance(accountId);
            return true;
        } catch (err) {
            const message = (err as Error)?.message ?? 'Failed to reset demo balance.';
            setError(message);
            return false;
        } finally {
            inFlight.current = false;
            setIsResetting(false);
        }
    }, []);

    return { reset, is_resetting, error };
};
