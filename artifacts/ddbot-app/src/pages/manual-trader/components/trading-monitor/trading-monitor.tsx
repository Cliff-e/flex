import { useState } from 'react';
import { OpenContract, HistoryContract, TradeStats } from '../../hooks/use-open-contracts';

type Tab = 'open' | 'history' | 'stats';

type TradingMonitorProps = {
    openContracts: OpenContract[];
    history: HistoryContract[];
    stats: TradeStats;
    onSell: (contractId: number) => void;
};

const fmt = (n: number, dec = 2) => n.toFixed(dec);

const formatTime = (ts: number) => {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const CONTRACT_TYPE_LABELS: Record<string, string> = {
    CALL: 'Rise', PUT: 'Fall', CALLE: 'Rise', PUTE: 'Fall',
    DIGITOVER: 'Over', DIGITUNDER: 'Under', DIGITMATCH: 'Matches',
    DIGITDIFF: 'Differs', DIGITEVEN: 'Even', DIGITODD: 'Odd',
    ONETOUCH: 'One Touch', NOTOUCH: 'No Touch',
    RANGE: 'Stays Between', UPORDOWN: 'Goes Outside',
    ACCU: 'Accumulator',
};

const contractLabel = (type: string) => CONTRACT_TYPE_LABELS[type] ?? type;

const OpenContractCard = ({ contract, onSell }: { contract: OpenContract; onSell: () => void }) => {
    const profit = contract.profit;
    const pnlClass =
        profit > 0 ? 'trading-monitor__contract-card-pnl--pos' :
        profit < 0 ? 'trading-monitor__contract-card-pnl--neg' :
                     'trading-monitor__contract-card-pnl--zero';
    const cardMod =
        profit > 0 ? 'trading-monitor__contract-card--profit' :
        profit < 0 ? 'trading-monitor__contract-card--loss' :
                     'trading-monitor__contract-card--zero';

    const ticksPassed  = contract.tick_passed  ?? 0;
    const tickTotal    = contract.tick_count   ?? 0;
    const progressPct  = tickTotal > 0 ? Math.min((ticksPassed / tickTotal) * 100, 100) : 0;
    const showProgress = tickTotal > 0;

    return (
        <div className={`trading-monitor__contract-card ${cardMod}`}>
            <div className='trading-monitor__contract-card-header'>
                <span className='trading-monitor__contract-card-type'>
                    {contractLabel(contract.contract_type)}
                </span>
                <span className='trading-monitor__contract-card-symbol'>{contract.symbol}</span>
            </div>

            <div className='trading-monitor__contract-card-row'>
                <span className='trading-monitor__contract-card-label'>Stake</span>
                <span className='trading-monitor__contract-card-val'>
                    {fmt(contract.buy_price)} {contract.currency}
                </span>
            </div>

            <div className='trading-monitor__contract-card-row'>
                <span className='trading-monitor__contract-card-label'>Current spot</span>
                <span className='trading-monitor__contract-card-val'>
                    {contract.current_spot_display_value || fmt(contract.current_spot, 5)}
                </span>
            </div>

            {showProgress && (
                <div className='trading-monitor__contract-card-row'>
                    <span className='trading-monitor__contract-card-label'>Ticks</span>
                    <span className='trading-monitor__contract-card-val'>
                        {ticksPassed} / {tickTotal}
                    </span>
                </div>
            )}

            <div className='trading-monitor__contract-card-row' style={{ marginTop: 4 }}>
                <span className='trading-monitor__contract-card-label'>P&amp;L</span>
                <span className={`trading-monitor__contract-card-pnl ${pnlClass}`}>
                    {profit >= 0 ? '+' : ''}{fmt(profit)} {contract.currency}
                </span>
            </div>

            {showProgress && (
                <div className='trading-monitor__contract-card-progress'>
                    <div
                        className='trading-monitor__contract-card-progress-bar'
                        style={{ width: `${progressPct}%` }}
                    />
                </div>
            )}

            <button className='trading-monitor__contract-card-sell-btn' onClick={onSell}>
                Sell @ {fmt(contract.bid_price)}
            </button>
        </div>
    );
};

const HistoryItem = ({ contract }: { contract: HistoryContract }) => {
    const won  = contract.status === 'won';
    const lost = contract.status === 'lost';
    const profit = contract.profit;

    return (
        <div className='trading-monitor__history-item'>
            <div className={`trading-monitor__history-item-dot trading-monitor__history-item-dot--${contract.status}`} />
            <div className='trading-monitor__history-item-info'>
                <div className='trading-monitor__history-item-type'>
                    {contractLabel(contract.contract_type)} · {contract.symbol}
                </div>
                <div className='trading-monitor__history-item-meta'>
                    {fmt(contract.buy_price)} {contract.currency} · {formatTime(contract.sell_time)}
                </div>
            </div>
            <div className={`trading-monitor__history-item-profit trading-monitor__history-item-profit--${profit >= 0 ? 'pos' : 'neg'}`}>
                {profit >= 0 ? '+' : ''}{fmt(profit)}
            </div>
        </div>
    );
};

const StatsPanel = ({ stats, currency }: { stats: TradeStats; currency: string }) => {
    if (stats.total === 0) {
        return (
            <div className='trading-monitor__empty'>
                <div className='trading-monitor__empty-icon'>📊</div>
                <span>No trades yet</span>
            </div>
        );
    }

    const profitMod = stats.total_profit > 0 ? '--pos' : stats.total_profit < 0 ? '--neg' : '';

    return (
        <div className='trading-monitor__stats'>
            <div className='trading-monitor__stat-card trading-monitor__stat-card--full'>
                <div className='trading-monitor__stat-card-label'>Total P&L</div>
                <div className={`trading-monitor__stat-card-value trading-monitor__stat-card-value${profitMod}`}>
                    {stats.total_profit >= 0 ? '+' : ''}{fmt(stats.total_profit)} {currency}
                </div>
            </div>

            <div className='trading-monitor__stat-card'>
                <div className='trading-monitor__stat-card-label'>Win Rate</div>
                <div className={`trading-monitor__stat-card-value trading-monitor__stat-card-value${stats.win_rate >= 50 ? '--pos' : '--neg'}`}>
                    {fmt(stats.win_rate, 1)}%
                </div>
                <div className='trading-monitor__stat-card-sub'>{stats.wins}W / {stats.losses}L</div>
            </div>

            <div className='trading-monitor__stat-card'>
                <div className='trading-monitor__stat-card-label'>Total Trades</div>
                <div className='trading-monitor__stat-card-value'>{stats.total}</div>
            </div>

            <div className='trading-monitor__stat-card'>
                <div className='trading-monitor__stat-card-label'>Total Staked</div>
                <div className='trading-monitor__stat-card-value'>{fmt(stats.total_stake)}</div>
                <div className='trading-monitor__stat-card-sub'>{currency}</div>
            </div>

            <div className='trading-monitor__stat-card'>
                <div className='trading-monitor__stat-card-label'>Avg Stake</div>
                <div className='trading-monitor__stat-card-value'>
                    {stats.total > 0 ? fmt(stats.total_stake / stats.total) : '0.00'}
                </div>
                <div className='trading-monitor__stat-card-sub'>{currency}</div>
            </div>
        </div>
    );
};

const TradingMonitor = ({ openContracts, history, stats, onSell }: TradingMonitorProps) => {
    const [activeTab, setActiveTab] = useState<Tab>('open');
    const currency = openContracts[0]?.currency ?? history[0]?.currency ?? 'USD';

    return (
        <div className='trading-monitor'>
            <div className='trading-monitor__tabs'>
                <button
                    className={`trading-monitor__tab${activeTab === 'open' ? ' trading-monitor__tab--active' : ''}`}
                    onClick={() => setActiveTab('open')}
                >
                    Open
                    {openContracts.length > 0 && (
                        <span className='trading-monitor__tab-badge'>{openContracts.length}</span>
                    )}
                </button>
                <button
                    className={`trading-monitor__tab${activeTab === 'history' ? ' trading-monitor__tab--active' : ''}`}
                    onClick={() => setActiveTab('history')}
                >
                    History
                    {history.length > 0 && (
                        <span className='trading-monitor__tab-badge'>{history.length}</span>
                    )}
                </button>
                <button
                    className={`trading-monitor__tab${activeTab === 'stats' ? ' trading-monitor__tab--active' : ''}`}
                    onClick={() => setActiveTab('stats')}
                >
                    Stats
                </button>
            </div>

            <div className='trading-monitor__content'>
                {activeTab === 'open' && (
                    openContracts.length === 0 ? (
                        <div className='trading-monitor__empty'>
                            <div className='trading-monitor__empty-icon'>🕐</div>
                            <span>No open positions</span>
                        </div>
                    ) : (
                        openContracts.map(c => (
                            <OpenContractCard
                                key={c.contract_id}
                                contract={c}
                                onSell={() => onSell(c.contract_id)}
                            />
                        ))
                    )
                )}

                {activeTab === 'history' && (
                    history.length === 0 ? (
                        <div className='trading-monitor__empty'>
                            <div className='trading-monitor__empty-icon'>📋</div>
                            <span>No trade history</span>
                        </div>
                    ) : (
                        history.map(c => (
                            <HistoryItem key={`${c.contract_id}-${c.sell_time}`} contract={c} />
                        ))
                    )
                )}

                {activeTab === 'stats' && (
                    <StatsPanel stats={stats} currency={currency} />
                )}
            </div>
        </div>
    );
};

export default TradingMonitor;
