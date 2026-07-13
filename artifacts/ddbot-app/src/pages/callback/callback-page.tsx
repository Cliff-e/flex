/**
 * CallbackPage — OAuth callback handler.
 *
 * This is the only OAuth callback in the application. The DigitalOcean
 * backend exchanges the authorization code with Deriv and redirects here
 * with a one-time ?auth_code=<code> — never the real access_token, which
 * would otherwise land in the URL bar, browser history, server logs,
 * analytics, and Referer headers.
 *
 * Responsibilities:
 *   1. Read ?auth_code= from the URL and strip it immediately.
 *   2. Exchange it for the complete session via POST /api/auth/exchange
 *      (JSON body — the token never appears in a URL). The backend fetches
 *      accounts server-side and returns the full session in one response.
 *   3. Persist credentials via AuthSessionManager (single source of truth).
 *   4. Redirect to the main app.
 *
 * /api/auth/accounts is NOT called from the frontend — the backend resolves
 * accounts during the exchange and includes them in the response. This avoids
 * the 403 Insufficient scopes error that occurred when the browser called the
 * accounts endpoint directly after receiving the token.
 *
 * Error path: if ?error= is present, show the error and offer a retry link.
 */
import { useEffect, useState } from 'react';
import Cookies from 'js-cookie';
import { clearAuthData } from '@/utils/auth-utils';
import { API_BASE_URL } from '@/utils/pkce';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { Button } from '@deriv-com/ui';

function maskToken(t: string | null | undefined): string {
    if (!t) return '(none)';
    if (t.length <= 12) return t.slice(0, 4) + '…';
    return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

/** Shape returned by /api/auth/accounts */
interface RestAccount {
    account_id?: string;
    id?: string;
    loginid?: string;
    balance?: number;
    currency?: string;
    account_currency?: string;
    account_type?: string;
    type?: string;
}

const CallbackPage = () => {
    const [signInError, setSignInError] = useState<string | null>(null);
    const [statusMsg, setStatusMsg] = useState<string>('Completing login…');

    useEffect(() => {
        const run = async () => {
            const params = new URLSearchParams(window.location.search);
            const authCode = params.get('auth_code');
            const errorParam = params.get('error');
            const errorDesc = params.get('error_description');

            // ── Error from backend ────────────────────────────────────────────
            if (errorParam) {
                console.error('[CallbackPage] OAuth error:', errorParam, errorDesc);
                setSignInError(errorDesc ?? errorParam);
                return;
            }

            // ── No auth code — unexpected ──────────────────────────────────────
            if (!authCode) {
                console.error('[CallbackPage] No auth_code in callback URL');
                setSignInError('No authorization code received. Please try logging in again.');
                return;
            }

            // Remove the code from the URL bar immediately — it's single-use,
            // but there's no reason to leave it in browser history or let it
            // appear in Referer headers during the async exchange/account fetch.
            window.history.replaceState({}, '', window.location.pathname);
            setStatusMsg('Completing sign-in…');

            // ── Exchange the one-time code for the complete session ───────────
            // The backend redeems the code, fetches accounts server-to-server,
            // and returns everything in one response. The frontend never calls
            // /api/auth/accounts — that was returning 403 Insufficient scopes.
            let accessToken: string;
            let primaryLoginid = '';
            let primaryCurrency = '';
            const accountsList: Record<string, string> = {};
            const clientAccounts: Record<string, {
                loginid: string; token: string; currency: string;
                account_type?: string; balance?: number;
            }> = {};
            const restBalances: Record<string, { balance: number; currency: string; type?: string }> = {};

            try {
                if (!API_BASE_URL) {
                    throw new Error('VITE_API_BASE_URL is not configured — cannot exchange auth code');
                }

                const exchangeRes = await fetch(`${API_BASE_URL}/api/auth/exchange`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: authCode }),
                });
                const exchangeData = (await exchangeRes.json().catch(() => null)) as
                    | {
                        access_token?: string;
                        primary_loginid?: string;
                        primary_currency?: string;
                        accounts?: RestAccount[];
                        error_description?: string;
                      }
                    | null;

                if (!exchangeRes.ok || !exchangeData?.access_token) {
                    throw new Error(
                        exchangeData?.error_description ?? 'Failed to exchange authorization code'
                    );
                }

                accessToken = exchangeData.access_token;
                setStatusMsg('Session received. Applying account info…');
                console.log('[CallbackPage] Received access_token:', maskToken(accessToken));

                // ── Apply accounts from the exchange response ──────────────────
                // The backend already sorted and resolved primary — use its values
                // directly, and re-derive the local maps for AuthSessionManager.
                primaryLoginid = exchangeData.primary_loginid ?? '';
                primaryCurrency = exchangeData.primary_currency ?? '';
                const rawAccounts = exchangeData.accounts ?? [];

                // Real accounts first, virtual last (mirrors backend sort for safety)
                const sorted = [...rawAccounts].sort(a => {
                    const t = (a.account_type ?? a.type ?? '').toLowerCase();
                    return t === 'demo' || t === 'virtual' ? 1 : -1;
                });

                for (const acct of sorted) {
                    const id = (acct.account_id ?? acct.id ?? acct.loginid ?? '') as string;
                    const cur = (acct.currency ?? acct.account_currency ?? '') as string;
                    const bal = Number(acct.balance ?? 0) || 0;
                    const atype = acct.account_type ?? acct.type ?? '';
                    if (!id) continue;
                    accountsList[id] = accessToken;
                    clientAccounts[id] = { loginid: id, token: accessToken, currency: cur, account_type: atype, balance: bal };
                    restBalances[id] = { balance: bal, currency: cur, type: atype };
                }

                console.log('[CallbackPage] Accounts from exchange:', Object.keys(accountsList).join(', ') || '(none)');
            } catch (exchangeErr) {
                console.error('[CallbackPage] Exchange failed:', exchangeErr);
                setSignInError(
                    exchangeErr instanceof Error
                        ? exchangeErr.message
                        : 'Failed to complete login. Please try again.'
                );
                return;
            }

            // ── Persist via AuthSessionManager (single source of truth) ───────
            // 1. Primary account credentials via setActiveAccount.
            //    setActiveAccount() already handles empty loginid correctly: it
            //    writes authToken to localStorage and skips active_loginid when
            //    loginid is falsy. The real loginid is resolved from the WS
            //    authorize() response in api-base.ts and written there.
            //    NEVER pass a sentinel value such as '__pending__' — it will
            //    escape into the OTP endpoint and the WS authorize() message.
            AuthSessionManager.setActiveAccount(primaryLoginid, accessToken);
            if (!primaryLoginid) {
                console.log('[CallbackPage] No loginid from accounts fetch — token stored; WS authorize() will resolve the real loginid');
            }

            // 2. Full account list (for account switcher)
            if (Object.keys(accountsList).length) {
                AuthSessionManager.setAccounts(accountsList, clientAccounts);
            }
            if (Object.keys(restBalances).length) {
                localStorage.setItem('restAccounts', JSON.stringify(restBalances));
            }

            // 3. Session cookie (marks session as established via OAuth callback)
            Cookies.set('logged_state', 'true', { expires: 30, path: '/', secure: true, sameSite: 'strict' });

            // ── Redirect to main app ──────────────────────────────────────────
            const account = primaryCurrency || 'USD';
            const redirectUrl = `${window.location.origin}/?account=${account}`;
            console.log('[CallbackPage] Auth complete — redirecting to:', redirectUrl);
            setStatusMsg(`Redirecting with account=${account}…`);
            window.location.replace(redirectUrl);
        };

        run().catch(err => {
            console.error('[CallbackPage] Unexpected error:', err);
            clearAuthData(false);
            Cookies.set('logged_state', 'false', { expires: 30, path: '/', secure: true, sameSite: 'strict' });
            setSignInError(err instanceof Error ? err.message : 'Authentication failed. Please try again.');
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (signInError) {
        return (
            <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', minHeight: '100vh', gap: '1.6rem', padding: '2rem',
            }}>
                <p style={{ color: 'red', textAlign: 'center', maxWidth: '600px' }}>
                    <strong>Login error:</strong> {signInError}
                </p>
                <Button
                    className='callback-return-button'
                    onClick={() => { window.location.href = window.location.origin; }}
                >
                    Return to App
                </Button>
            </div>
        );
    }

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', minHeight: '100vh', gap: '0.8rem',
        }}>
            <p>Completing login…</p>
            <p style={{ color: '#888', fontSize: '0.8rem' }}>{statusMsg}</p>
        </div>
    );
};

export default CallbackPage;
