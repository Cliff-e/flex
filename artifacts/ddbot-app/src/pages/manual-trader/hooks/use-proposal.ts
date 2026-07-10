import { useCallback, useEffect, useRef, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';

export type ProposalState = {
    id: string;
    ask_price: number;
    payout: number;
    longcode: string;
    display_value: string;
    spot: number;
};

export type UseProposalParams = {
    symbol: string;
    contract_type: string;
    amount: number;
    duration: number;
    duration_unit: string;
    barrier?: string;
    currency: string;
    enabled: boolean;
};

export const useProposal = (params: UseProposalParams) => {
    const [proposal, setProposal] = useState<ProposalState | null>(null);
    const [error, setError]       = useState<string | null>(null);
    const [isLoading, setLoading] = useState(false);

    const subRef   = useRef<{ unsubscribe: () => void } | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const genRef   = useRef(0);

    const sendProposal = useCallback(() => {
        if (!params.enabled || !api_base.api || !params.symbol) {
            setProposal(null); setError(null); setLoading(false);
            return;
        }

        subRef.current?.unsubscribe();
        subRef.current = null;

        const gen = ++genRef.current;
        setLoading(true);
        setError(null);

        const sub = api_base.api.onMessage().subscribe(({ data }: any) => {
            if (gen !== genRef.current) { sub.unsubscribe(); return; }

            if (data?.msg_type === 'proposal') {
                if (data.error) {
                    setError(data.error.message ?? 'Proposal failed');
                    setProposal(null);
                } else if (data.proposal) {
                    setProposal({
                        id: data.proposal.id ?? '',
                        ask_price: parseFloat(data.proposal.ask_price ?? '0'),
                        payout: parseFloat(data.proposal.payout ?? '0'),
                        longcode: data.proposal.longcode ?? '',
                        display_value: data.proposal.display_value ?? '',
                        spot: parseFloat(data.proposal.spot ?? '0'),
                    });
                    setError(null);
                }
                setLoading(false);
                sub.unsubscribe();
                subRef.current = null;
            }
        });

        subRef.current = sub;

        const req: Record<string, unknown> = {
            proposal: 1,
            amount: String(params.amount),
            basis: 'stake',
            contract_type: params.contract_type,
            currency: params.currency || 'USD',
            duration: params.duration,
            duration_unit: params.duration_unit,
            symbol: params.symbol,
        };
        if (params.barrier !== undefined && params.barrier !== '') {
            req.barrier = params.barrier;
        }

        try {
            (api_base.api as any).send(req);
        } catch {
            setError('Failed to send proposal');
            setLoading(false);
            sub.unsubscribe();
            subRef.current = null;
        }
    }, [
        params.enabled, params.symbol, params.contract_type,
        params.amount, params.duration, params.duration_unit,
        params.barrier, params.currency,
    ]);

    useEffect(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (!params.enabled || !params.symbol) {
            setProposal(null); setError(null); setLoading(false);
            return;
        }
        setLoading(true);
        timerRef.current = setTimeout(sendProposal, 600);
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            subRef.current?.unsubscribe();
        };
    }, [sendProposal, params.enabled, params.symbol]);

    useEffect(() => {
        return () => {
            subRef.current?.unsubscribe();
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    return { proposal, error, isLoading, refetch: sendProposal };
};
