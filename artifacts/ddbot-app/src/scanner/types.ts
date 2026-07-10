export type Strategy =
    | 'over1'
    | 'over2'
    | 'over3'
    | 'evenodd'
    | 'differ';

export interface ScanResult {
    symbol: string;
    probability: number;
}