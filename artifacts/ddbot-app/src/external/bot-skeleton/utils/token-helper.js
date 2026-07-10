import { safeJsonParse } from '@/utils/safe-json';

export const getTokenList = () => {
    const tokenList = localStorage.getItem('tokenList');
    return safeJsonParse(tokenList, {});
};

export const removeAllTokens = () => {
    localStorage.removeItem('tokenList');
};
