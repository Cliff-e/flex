import { useState, useCallback, useRef, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { api_base } from '@/external/bot-skeleton';
import { useOpenContracts } from './hooks/use-open-contracts';
import TradingControls from './components/trading-controls/trading-controls';
import TraderChart from './components/trader-chart/trader-chart';
import TradingMonitor from './components/trading-monitor/trading-monitor';
import './manual-trader.scss';

const DEFAULT_SYMBOL = 'R_100';

const ManualTrader = observer(() => {
    const [symbol, setSymbol] = useState<string>(DEFAULT_SYMBOL);
    const [lastPrice, setLastPrice]         = useState<number | null>(null);
    const [prevPrice, setPrevPrice]         = useState<number | null>(null);
    const tickSubRef = useRef<{ unsubscribe: () => void } | null>(null);

    const { openContracts, history, stats, trackContract, sellContract } = useOpenContracts();

    // ── Live price feed via api_base ────────────────────────────────────────
    useEffect(() => {
        if (!api_base.api) return;

        tickSubRef.current?.unsubscribe();

        const sub = api_base.api.onMessage().subscribe(({ data }: any) => {
            if (data?.msg_type === 'tick' && data.tick?.symbol === symbol) {
                const price = parseFloat(data.tick.quote);
                if (!isNaN(price)) {
                    setPrevPrice(p => p);
                    setLastPrice(prev => { setPrevPrice(prev); return price; });
                }
            }
        });

        tickSubRef.current = sub;

        try {
            (api_base.api as any).send({ ticks: symbol, subscribe: 1 });
        } catch { /* ignore */ }

        return () => {
            sub.unsubscribe();
            try {
                if (api_base.api) (api_base.api as any).send({ forget_all: 'ticks' });
            } catch { /* ignore */ }
        };
    }, [symbol]);

    const priceDirection: 'up' | 'down' | 'neutral' =
        lastPrice !== null && prevPrice !== null
            ? lastPrice > prevPrice ? 'up'
            : lastPrice < prevPrice ? 'down'
            : 'neutral'
        : 'neutral';

    const handleSymbolChange = useCallback((newSymbol: string) => {
        setSymbol(newSymbol);
        setLastPrice(null);
        setPrevPrice(null);
    }, []);

    const handleTrade = useCallback((contractId: number) => {
        trackContract(contractId);
    }, [trackContract]);

    return (
        <div className='manual-trader'>
            <div className='manual-trader__panels'>
                <TradingControls
                    symbol={symbol}
                    onSymbolChange={handleSymbolChange}
                    onTrade={handleTrade}
                />
                <TraderChart
                    symbol={symbol}
                    onSymbolChange={handleSymbolChange}
                    lastPrice={lastPrice}
                    priceDirection={priceDirection}
                />
                <TradingMonitor
                    openContracts={openContracts}
                    history={history}
                    stats={stats}
                    onSell={sellContract}
                />
            </div>
        </div>
    );
});

export default ManualTrader;
