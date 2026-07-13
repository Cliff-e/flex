export const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

export type AccountType = 'demo' | 'real';

export function detectAccountType(loginId: string): AccountType {
    return /^(VRT|VRW)/i.test(loginId) ? 'demo' : 'real';
}
