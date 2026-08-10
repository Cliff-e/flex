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
 *   • SharedExitDigitHistory           — rolling exit digit history (vh_virtual)
 *
 * Reactivity: subscribes to the SAME store subscriptions the VH pipeline
 * already uses (TransactionsStore.subscribe + subscribeToExitDigitHistory),
 * so the UI updates instantly when a virtual transaction commits or an
 * exit digit is appended. No polling.
 */
const RECENT_TRADES_CAP = 10;

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
            const lastVh = [...history].reverse().find(entry => entry.source === 'vh_virtual');
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
    const netProfit = records.reduce((sum, r) => sum + (r.profit ?? 0), 0);
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
                    <div className='run-panel__tile-title'>{localize('Net Profit / Loss')}</div>
                    <div
                        className={[
                            'run-panel__tile-content run-panel__stat-amount',
                            netProfit > 0 && 'run-panel__stat-amount--positive',
                            netProfit < 0 && 'run-panel__stat-amount--negative',
                        ]
                            .filter(Boolean)
                            .join(' ')}
                    >
                        {netProfit.toFixed(2)}
                    </div>
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
                        {recentTrades.map(record => (
                            <li key={record.contractId} className='virtual-hook-results__item'>
                                <span className='virtual-hook-results__item-id'>{record.contractId}</span>
                                <span className='virtual-hook-results__item-type'>{record.contractType}</span>
                                <span
                                    className={[
                                        'virtual-hook-results__item-status',
                                        record.won
                                            ? 'virtual-hook-results__item-status--won'
                                            : 'virtual-hook-results__item-status--lost',
                                    ].join(' ')}
                                >
                                    {record.won ? localize('WON') : localize('LOST')}
                                </span>
                                <span className='virtual-hook-results__item-digit'>
                                    {record.exitDigit !== null && record.exitDigit !== undefined
                                        ? `${localize('Exit')}: ${record.exitDigit}`
                                        : ''}
                                </span>
                                <span className='virtual-hook-results__item-profit'>{record.profit.toFixed(2)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
};

export default VirtualHookResults;