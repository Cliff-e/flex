import React from 'react';
import { localize } from '@deriv-com/translations';
import { getVHStore, isVHRuntimeWired } from '@/bot/virtualHook/VHRuntime';
import { subscribeToExitDigitHistory, getExitDigitHistory } from '@/bot/sharedExitDigitHistory';
import type { TransactionRecord } from '@/bot/virtualHook/TransactionPipeline';

/**
 * Virtual Hook results panel for the XML Bot Builder run panel.
 *
 * Renders a live summary of the Virtual Hook stores WITHOUT creating a
 * second source of truth. The existing VH stores are the single source:
 *   • TransactionsStore  (getVHStore)  — committed virtual transactions
 *   • SharedExitDigitHistory           — rolling exit digit history (VH)
 *
 * This panel is strictly OBSERVATIONAL: it never displays or aggregates
 * financial figures (buy price, stake, payout, profit/loss) and never
 * writes to the real accounting stores — it only reads the VH stores.
 *
 * Reactivity: subscribes to the SAME store subscriptions the VH pipeline
 * already uses (TransactionsStore.subscribe + subscribeToExitDigitHistory),
 * so the UI updates instantly when a virtual transaction commits or an
 * exit digit is appended. No polling.
 */
const RECENT_TRADES_CAP = 10;

/**
 * Spot/digit detail fields are being added to TransactionRecord separately.
 * Intersect them here (all optional) so this file compiles both before and
 * after that change lands — absent fields simply render as "—".
 */
type TransactionRecordWithSpots = TransactionRecord & {
    entryTick?: number | null;
    entryDigit?: number | null;
    exitTick?: number | null;
};

/** Format a spot/digit pair, guarding against absent/null values. */
const formatSpotDigit = (spot: number | null, digit: number | null): string => {
    if (spot === null && digit === null) return '—';
    if (spot === null) return String(digit);
    return digit === null ? String(spot) : `${spot} (${digit})`;
};

const VirtualHookResults = () => {
    const [, setVersion] = React.useState(0);
    const [records, setRecords] = React.useState<TransactionRecord[]>([]);
    const [lastExitDigit, setLastExitDigit] = React.useState<number | null>(null);

    React.useEffect(() => {
        // Snapshot the current data immediately.
        const refresh = () => {
            const store = getVHStore();
            setRecords(store ? store.getRecords() : []);
            const history = getExitDigitHistory();
            const lastVh = [...history].reverse().find(entry => entry.source === 'VH');
            setLastExitDigit(lastVh ? lastVh.digit : null);
            setVersion(v => v + 1);
        };

        refresh();

        const store = getVHStore();
        const unsubStore = store?.subscribe?.(() => refresh());
        const unsubHistory = subscribeToExitDigitHistory(() => refresh());

        return () => {
            unsubStore?.();
            unsubHistory();
        };
    }, []);

    const wired = isVHRuntimeWired();
    const totalTrades = records.length;
    const wins = records.filter(r => r.won).length;
    const losses = totalTrades - wins;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const recentTrades = records.slice(-RECENT_TRADES_CAP).reverse();

    return (
        <div className='virtual-hook-results' data-testid='virtual-hook-results'>
            <div className='run-panel__stat--tiles'>
                <div className='run-panel__tile'>
                    <div className='run-panel__tile-title'>{localize('Status')}</div>
                    <div className='run-panel__tile-content'>{wired ? localize('Connected') : localize('Not started')}</div>
                </div>
                <div className='run-panel__tile'>
                    <div className='run-panel__tile-title'>{localize('Virtual Trades')}</div>
                    <div className='run-panel__tile-content'>{totalTrades}</div>
                </div>
                <div className='run-panel__tile'>
                    <div className='run-panel__tile-title'>{localize('Wins')}</div>
                    <div className='run-panel__tile-content run-panel__stat-amount--positive'>{wins}</div>
                </div>
                <div className='run-panel__tile'>
                    <div className='run-panel__tile-title'>{localize('Losses')}</div>
                    <div className='run-panel__tile-content run-panel__stat-amount--negative'>{losses}</div>
                </div>
                <div className='run-panel__tile'>
                    <div className='run-panel__tile-title'>{localize('Win Rate')}</div>
                    <div className='run-panel__tile-content'>{totalTrades > 0 ? `${winRate.toFixed(1)}%` : '—'}</div>
                </div>
                <div className='run-panel__tile'>
                    <div className='run-panel__tile-title'>{localize('Last Exit Digit')}</div>
                    <div className='run-panel__tile-content'>{lastExitDigit !== null ? lastExitDigit : '—'}</div>
                </div>
            </div>

            <div className='virtual-hook-results__recent'>
                <div className='virtual-hook-results__recent-title'>{localize('Recent Virtual Trades')}</div>
                {recentTrades.length === 0 ? (
                    <div className='virtual-hook-results__empty'>{localize('No virtual trades yet.')}</div>
                ) : (
                    <ul className='virtual-hook-results__list'>
                        {recentTrades.map(record => {
                            const rec = record as TransactionRecordWithSpots;
                            const entrySpot = rec.entryTick ?? null;
                            const entryDigit = rec.entryDigit ?? null;
                            const exitSpot = rec.exitTick ?? null;
                            const exitDigit = rec.exitDigit ?? null;
                            return (
                                <li key={record.contractId} className='virtual-hook-results__item'>
                                    <span className='virtual-hook-results__item-label'>{localize('Virtual Hook')}</span>
                                    <span className='virtual-hook-results__item-type'>{record.contractType}</span>
                                    <span className='virtual-hook-results__item-spot'>
                                        {`${localize('Entry')}: ${formatSpotDigit(entrySpot, entryDigit)}`}
                                    </span>
                                    <span className='virtual-hook-results__item-spot'>
                                        {`${localize('Exit')}: ${formatSpotDigit(exitSpot, exitDigit)}`}
                                    </span>
                                    <span
                                        className={[
                                            'virtual-hook-results__item-status',
                                            record.won
                                                ? 'virtual-hook-results__item-status--won'
                                                : 'virtual-hook-results__item-status--lost',
                                        ].join(' ')}
                                    >
                                        {record.won ? localize('virtual won') : localize('virtual lost')}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
};

export default VirtualHookResults;
