import { useCallback, useEffect, useRef, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { RuntimeLogger } from '@/runtime/RuntimeLogger';

const MANUAL_TRADER_RUNTIME_ID = 'manual-trader';

export type OpenContract = {
    contract_id: number;
    symbol: string;
    contract_type: string;
    shortcode: string;
    buy_price: number;
    bid_price: number;
    current_spot: number;
    current_spot_display_value: string;
    profit: number;
    profit_percentage: number;
    status: 'open';
    date_start: number;
    date_expiry: number;
    entry_tick: number | null;
    longcode: string;
    currency: string;
    payout: number;
    tick_count: number | null;
    tick_passed: number | null;
    barrier: string | null;
};

export type HistoryContract = Omit<OpenContract, 'status'> & {
    status: 'won' | 'lost' | 'sold';
    sell_price: number;
    sell_time: number;
};

export type TradeStats = {
    total: number;
    wins: number;
    losses: number;
    win_rate: number;
    total_profit: number;
    total_stake: number;
};

const MAX_HISTORY = 50;

export const useOpenContracts = () => {
    const [openContracts, setOpenContracts] = useState<OpenContract[]>([]);
    const [history, setHistory]             = useState<HistoryContract[]>([]);
    const globalSubRef = useRef<{ unsubscribe: () => void } | null>(null);

    const updateContract = useCallback((poc: any) => {
        const id: number = poc.contract_id;
        const settled =
            poc.status === 'won' || poc.status === 'lost' || poc.status === 'sold' ||
            poc.is_expired === 1 || poc.is_settleable === 1;

        if (settled) {
            RuntimeLogger.recordTrade(MANUAL_TRADER_RUNTIME_ID, poc);
            RuntimeLogger.updatePosition(MANUAL_TRADER_RUNTIME_ID, '--');

            setOpenContracts(prev => prev.filter(c => c.contract_id !== id));
            setHistory(prev => [{
                contract_id: id,
                symbol: poc.underlying ?? poc.symbol ?? '',
                contract_type: poc.contract_type ?? '',
                shortcode: poc.shortcode ?? '',
                buy_price: parseFloat(poc.buy_price ?? '0'),
                bid_price: parseFloat(poc.bid_price ?? poc.sell_price ?? '0'),
                current_spot: parseFloat(poc.exit_tick ?? poc.current_spot ?? '0'),
                current_spot_display_value: poc.exit_tick_display_value ?? poc.current_spot_display_value ?? '',
                profit: parseFloat(poc.profit ?? '0'),
                profit_percentage: parseFloat(poc.profit_percentage ?? '0'),
                status: poc.status as 'won' | 'lost' | 'sold',
                date_start: poc.date_start ?? 0,
                date_expiry: poc.date_expiry ?? 0,
                entry_tick: poc.entry_tick ? parseFloat(poc.entry_tick) : null,
                longcode: poc.longcode ?? '',
                currency: poc.currency ?? 'USD',
                payout: parseFloat(poc.payout ?? '0'),
                tick_count: poc.tick_count ?? null,
                tick_passed: poc.tick_passed ?? null,
                barrier: poc.barrier ?? poc.high_barrier ?? null,
                sell_price: parseFloat(poc.sell_price ?? poc.bid_price ?? '0'),
                sell_time: poc.sell_time ?? Math.floor(Date.now() / 1000),
            } as HistoryContract, ...prev].slice(0, MAX_HISTORY));
        } else {
            const open: OpenContract = {
                contract_id: id,
                symbol: poc.underlying ?? poc.symbol ?? '',
                contract_type: poc.contract_type ?? '',
                shortcode: poc.shortcode ?? '',
                buy_price: parseFloat(poc.buy_price ?? '0'),
                bid_price: parseFloat(poc.bid_price ?? '0'),
                current_spot: parseFloat(poc.current_spot ?? '0'),
                current_spot_display_value: poc.current_spot_display_value ?? '',
                profit: parseFloat(poc.profit ?? '0'),
                profit_percentage: parseFloat(poc.profit_percentage ?? '0'),
                status: 'open',
                date_start: poc.date_start ?? 0,
                date_expiry: poc.date_expiry ?? 0,
                entry_tick: poc.entry_tick ? parseFloat(poc.entry_tick) : null,
                longcode: poc.longcode ?? '',
                currency: poc.currency ?? 'USD',
                payout: parseFloat(poc.payout ?? '0'),
                tick_count: poc.tick_count ?? null,
                tick_passed: poc.tick_passed ?? null,
                barrier: poc.barrier ?? poc.high_barrier ?? null,
            };
            RuntimeLogger.updatePosition(
                MANUAL_TRADER_RUNTIME_ID,
                `${open.contract_type} @ ${open.symbol}`.trim()
            );
            setOpenContracts(prev => {
                const idx = prev.findIndex(c => c.contract_id === id);
                if (idx >= 0) { const next = [...prev]; next[idx] = open; return next; }
                return [...prev, open];
            });
        }
    }, []);

    useEffect(() => {
        if (!api_base.api) return;
        const sub = api_base.api.onMessage().subscribe(({ data }: any) => {
            if (data?.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
                updateContract(data.proposal_open_contract);
            }
        });
        globalSubRef.current = sub;
        return () => { sub.unsubscribe(); globalSubRef.current = null; };
    }, [updateContract]);

    const trackContract = useCallback((contractId: number) => {
        if (!api_base.api) return;
        try {
            (api_base.api as any).send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
        } catch { /* ignore */ }
    }, []);

    const sellContract = useCallback((contractId: number) => {
        if (!api_base.api) return;
        try { (api_base.api as any).send({ sell: contractId, price: 0 }); }
        catch { /* ignore */ }
    }, []);

    const stats: TradeStats = history.reduce<TradeStats>(
        (acc, c) => {
            acc.total += 1;
            if (c.status === 'won') acc.wins += 1;
            else if (c.status === 'lost') acc.losses += 1;
            acc.total_profit += c.profit;
            acc.total_stake  += c.buy_price;
            acc.win_rate = acc.total > 0 ? (acc.wins / acc.total) * 100 : 0;
            return acc;
        },
        { total: 0, wins: 0, losses: 0, win_rate: 0, total_profit: 0, total_stake: 0 }
    );

    return { openContracts, history, stats, trackContract, sellContract };
};
