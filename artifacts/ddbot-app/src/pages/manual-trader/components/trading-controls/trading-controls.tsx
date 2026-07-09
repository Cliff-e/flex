import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { useApiBase } from '@/hooks/useApiBase';
import { api_base } from '@/external/bot-skeleton';
import { RuntimeLogger } from '@/runtime/RuntimeLogger';
import { useActiveSymbols } from '../../hooks/use-active-symbols';
import { useProposal } from '../../hooks/use-proposal';

const MANUAL_TRADER_RUNTIME_ID = 'manual-trader';

type ContractCategory = {
    label: string;
    contracts: { type: string; label: string }[];
    duration_units: string[];
    needs_barrier: boolean;
    barrier_label?: string;
    barrier_options?: string[];
};

const CONTRACT_CATEGORIES: ContractCategory[] = [
    {
        label: 'Rise/Fall',
        contracts: [
            { type: 'CALL', label: 'Rise' },
            { type: 'PUT',  label: 'Fall' },
        ],
        duration_units: ['t', 'm', 'h', 'd'],
        needs_barrier: false,
    },
    {
        label: 'Digits',
        contracts: [
            { type: 'DIGITOVER',  label: 'Over'    },
            { type: 'DIGITUNDER', label: 'Under'   },
            { type: 'DIGITMATCH', label: 'Matches' },
            { type: 'DIGITDIFF',  label: 'Differs' },
            { type: 'DIGITEVEN',  label: 'Even'    },
            { type: 'DIGITODD',   label: 'Odd'     },
        ],
        duration_units: ['t'],
        needs_barrier: true,
        barrier_label: 'Digit (0–9)',
        barrier_options: ['0','1','2','3','4','5','6','7','8','9'],
    },
    {
        label: 'Touch',
        contracts: [
            { type: 'ONETOUCH', label: 'One Touch' },
            { type: 'NOTOUCH',  label: 'No Touch'  },
        ],
        duration_units: ['t', 'm', 'h', 'd'],
        needs_barrier: true,
        barrier_label: 'Barrier',
    },
    {
        label: 'Higher/Lower',
        contracts: [
            { type: 'CALL', label: 'Higher' },
            { type: 'PUT',  label: 'Lower'  },
        ],
        duration_units: ['m', 'h', 'd'],
        needs_barrier: true,
        barrier_label: 'Barrier',
    },
];

const DURATION_UNIT_LABELS: Record<string, string> = {
    t: 'ticks', s: 'sec', m: 'min', h: 'hrs', d: 'days',
};

const DURATION_DEFAULTS: Record<string, number> = {
    t: 5, s: 60, m: 5, h: 1, d: 1,
};

type TradingControlsProps = {
    symbol: string;
    onSymbolChange: (symbol: string) => void;
    onTrade: (contractId: number) => void;
};

const TradingControls = observer(({ symbol, onSymbolChange, onTrade }: TradingControlsProps) => {
    const { client } = useStore() ?? {};
    const { isAuthorized } = useApiBase();
    const { grouped } = useActiveSymbols();

    const [categoryIdx, setCategoryIdx]   = useState(0);
    const [contractType, setContractType] = useState('CALL');
    const [amount, setAmount]             = useState('10');
    const [duration, setDuration]         = useState(5);
    const [durationUnit, setDurationUnit] = useState('t');
    const [barrier, setBarrier]           = useState('');
    const [isBuying, setIsBuying]         = useState(false);
    const [tradeError, setTradeError]     = useState<string | null>(null);

    const category = CONTRACT_CATEGORIES[categoryIdx];
    const currency = client?.currency ?? 'USD';
    const balance  = client?.balance  ?? '0';

    const needsBarrier = category.needs_barrier &&
        (contractType !== 'DIGITEVEN' && contractType !== 'DIGITODD');

    const { proposal, error: proposalError, isLoading: proposalLoading } = useProposal({
        symbol,
        contract_type: contractType,
        amount: parseFloat(amount) || 0,
        duration,
        duration_unit: durationUnit,
        barrier: needsBarrier ? barrier : undefined,
        currency,
        enabled: isAuthorized && parseFloat(amount) > 0,
    });

    const handleCategoryChange = (idx: number) => {
        const cat = CONTRACT_CATEGORIES[idx];
        setCategoryIdx(idx);
        setContractType(cat.contracts[0].type);
        const defaultUnit = cat.duration_units[0];
        setDurationUnit(defaultUnit);
        setDuration(DURATION_DEFAULTS[defaultUnit] ?? 5);
        setBarrier('');
        setTradeError(null);
    };

    const handleContractType = (type: string) => {
        setContractType(type);
        setTradeError(null);
    };

    const handleDurationUnitChange = (unit: string) => {
        setDurationUnit(unit);
        setDuration(DURATION_DEFAULTS[unit] ?? 5);
    };

    const handleBuy = async () => {
        if (!isAuthorized) { setTradeError('Please log in to trade'); return; }
        if (!api_base.api)  { setTradeError('Not connected to server'); return; }
        if (!proposal?.id)  { setTradeError('No active proposal'); return; }

        setIsBuying(true);
        setTradeError(null);

        try {
            const buySubRef = { unsub: () => {} };
            const subHandle = api_base.api.onMessage().subscribe(({ data }: any) => {
                if (data?.msg_type === 'buy') {
                    buySubRef.unsub();
                    if (data.error) {
                        setTradeError(data.error.message ?? 'Trade failed');
                        RuntimeLogger.log('ERROR', `Manual trade failed: ${data.error.message ?? 'unknown error'}`, MANUAL_TRADER_RUNTIME_ID);
                    } else if (data.buy?.contract_id) {
                        RuntimeLogger.start(MANUAL_TRADER_RUNTIME_ID, {
                            name: 'Manual Trader',
                            strategy: contractType,
                            market: symbol,
                            reset: false,
                        });
                        RuntimeLogger.log(
                            'SUCCESS',
                            `Manual trade placed — ${contractType} on ${symbol} for ${amount} ${currency}`,
                            MANUAL_TRADER_RUNTIME_ID
                        );
                        onTrade(data.buy.contract_id);
                    }
                    setIsBuying(false);
                }
            });
            buySubRef.unsub = () => subHandle.unsubscribe();

            setTimeout(() => { buySubRef.unsub(); setIsBuying(false); }, 10000);

            (api_base.api as any).send({ buy: proposal.id, price: proposal.ask_price });
        } catch (e: any) {
            setTradeError(e?.message ?? 'Trade failed');
            setIsBuying(false);
        }
    };

    const isBuyDisabled = !isAuthorized || !proposal || proposalLoading || isBuying ||
        parseFloat(amount) <= 0;

    const isRiseFall = category.label === 'Rise/Fall' || category.label === 'Higher/Lower';

    return (
        <div className='trading-controls'>
            {/* Balance */}
            <div className='trading-controls__section'>
                <div className='trading-controls__section-title'>Account</div>
                <div className='trading-controls__balance'>
                    <span className='trading-controls__balance-label'>Balance</span>
                    <div>
                        <span className='trading-controls__balance-value'>
                            {parseFloat(balance).toFixed(2)}
                        </span>
                        <span className='trading-controls__balance-currency'>{currency}</span>
                    </div>
                </div>
            </div>

            {/* Market */}
            <div className='trading-controls__section'>
                <div className='trading-controls__section-title'>Market</div>
                <select
                    className='trading-controls__select'
                    value={symbol}
                    onChange={e => onSymbolChange(e.target.value)}
                >
                    {Object.entries(grouped).map(([group, syms]) => (
                        <optgroup key={group} label={group}>
                            {syms.map(s => (
                                <option key={s.symbol} value={s.symbol}>{s.display_name}</option>
                            ))}
                        </optgroup>
                    ))}
                </select>
            </div>

            {/* Contract type */}
            <div className='trading-controls__section'>
                <div className='trading-controls__section-title'>Contract Type</div>
                <div className='trading-controls__category-tabs'>
                    {CONTRACT_CATEGORIES.map((cat, i) => (
                        <button
                            key={cat.label}
                            className={`trading-controls__category-tab${categoryIdx === i ? ' trading-controls__category-tab--active' : ''}`}
                            onClick={() => handleCategoryChange(i)}
                        >
                            {cat.label}
                        </button>
                    ))}
                </div>
                <div className='trading-controls__contract-types'>
                    {category.contracts.map(c => (
                        <button
                            key={c.type}
                            className={`trading-controls__contract-btn${contractType === c.type ? ' trading-controls__contract-btn--active' : ''}`}
                            onClick={() => handleContractType(c.type)}
                        >
                            {c.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Stake */}
            <div className='trading-controls__section'>
                <div className='trading-controls__section-title'>Stake ({currency})</div>
                <input
                    type='number'
                    min='0.35'
                    step='1'
                    className={`trading-controls__input${parseFloat(amount) <= 0 ? ' trading-controls__input--error' : ''}`}
                    value={amount}
                    onChange={e => { setAmount(e.target.value); setTradeError(null); }}
                />
            </div>

            {/* Duration */}
            <div className='trading-controls__section'>
                <div className='trading-controls__section-title'>Duration</div>
                <div className='trading-controls__input-row'>
                    <input
                        type='number'
                        min='1'
                        className='trading-controls__input'
                        value={duration}
                        onChange={e => setDuration(parseInt(e.target.value, 10) || 1)}
                    />
                    <select
                        className='trading-controls__unit-select'
                        value={durationUnit}
                        onChange={e => handleDurationUnitChange(e.target.value)}
                    >
                        {category.duration_units.map(u => (
                            <option key={u} value={u}>{DURATION_UNIT_LABELS[u] ?? u}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Barrier (conditional) */}
            {needsBarrier && (
                <div className='trading-controls__section'>
                    <div className='trading-controls__section-title'>
                        {category.barrier_label ?? 'Barrier'}
                    </div>
                    {category.barrier_options ? (
                        <select
                            className='trading-controls__select'
                            value={barrier}
                            onChange={e => setBarrier(e.target.value)}
                        >
                            <option value=''>Select digit</option>
                            {category.barrier_options.map(o => (
                                <option key={o} value={o}>{o}</option>
                            ))}
                        </select>
                    ) : (
                        <input
                            type='text'
                            placeholder='+0.001 or 1234.56'
                            className='trading-controls__input'
                            value={barrier}
                            onChange={e => setBarrier(e.target.value)}
                        />
                    )}
                </div>
            )}

            {/* Proposal preview */}
            <div className={`trading-controls__proposal-box${proposalLoading ? ' trading-controls__proposal-box--loading' : ''}${proposalError ? ' trading-controls__proposal-box--error' : ''}${!proposal && !proposalLoading && !proposalError ? ' trading-controls__proposal-box--empty' : ''}`}>
                {proposalError ? (
                    <span className='trading-controls__proposal-box-error'>{proposalError}</span>
                ) : proposal ? (
                    <>
                        <div className='trading-controls__proposal-box-row'>
                            <span className='trading-controls__proposal-box-label'>Cost</span>
                            <span className='trading-controls__proposal-box-value'>
                                {proposal.ask_price.toFixed(2)} {currency}
                            </span>
                        </div>
                        <div className='trading-controls__proposal-box-row'>
                            <span className='trading-controls__proposal-box-label'>Payout</span>
                            <span className='trading-controls__proposal-box-value'>
                                {proposal.payout.toFixed(2)} {currency}
                            </span>
                        </div>
                        {proposal.longcode && (
                            <div className='trading-controls__proposal-box-longcode'>
                                {proposal.longcode}
                            </div>
                        )}
                    </>
                ) : (
                    <span className='trading-controls__proposal-box-hint'>
                        {isAuthorized ? (proposalLoading ? 'Fetching quote…' : 'Fill in details above') : 'Log in to get quotes'}
                    </span>
                )}
            </div>

            {/* Buy buttons */}
            {!isAuthorized ? (
                <div className='trading-controls__login-notice'>Log in to start trading</div>
            ) : isRiseFall && category.contracts.length === 2 ? (
                <div className='trading-controls__buy-buttons'>
                    <button
                        className='trading-controls__buy-btn trading-controls__buy-btn--rise'
                        disabled={isBuyDisabled || contractType !== category.contracts[0].type}
                        onClick={() => { setContractType(category.contracts[0].type); setTimeout(handleBuy, 50); }}
                    >
                        <span>▲ {category.contracts[0].label}</span>
                        {proposal && <span className='trading-controls__buy-btn-price'>{proposal.ask_price.toFixed(2)}</span>}
                    </button>
                    <button
                        className='trading-controls__buy-btn trading-controls__buy-btn--fall'
                        disabled={isBuyDisabled || contractType !== category.contracts[1].type}
                        onClick={() => { setContractType(category.contracts[1].type); setTimeout(handleBuy, 50); }}
                    >
                        <span>▼ {category.contracts[1].label}</span>
                        {proposal && <span className='trading-controls__buy-btn-price'>{proposal.ask_price.toFixed(2)}</span>}
                    </button>
                </div>
            ) : (
                <div className='trading-controls__buy-buttons'>
                    <button
                        className='trading-controls__buy-btn trading-controls__buy-btn--single'
                        disabled={isBuyDisabled}
                        onClick={handleBuy}
                    >
                        <span>{isBuying ? 'Placing…' : `Buy — ${category.contracts.find(c => c.type === contractType)?.label ?? contractType}`}</span>
                        {proposal && !isBuying && (
                            <span className='trading-controls__buy-btn-price'>{proposal.ask_price.toFixed(2)} {currency}</span>
                        )}
                    </button>
                </div>
            )}

            {/* Trade error */}
            {tradeError && (
                <div className='trading-controls__trade-error'>{tradeError}</div>
            )}
        </div>
    );
});

export default TradingControls;
