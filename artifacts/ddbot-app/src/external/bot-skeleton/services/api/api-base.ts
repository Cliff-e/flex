import CommonStore from '@/stores/common-store';
import { TAuthData } from '@/types/api-types';
import { AccountModeController } from '@/utils/AccountModeController';
import { clearAuthData } from '@/utils/auth-utils';
import { EventBus } from '@/utils/EventBus';
import { WebSocketManager } from '@/utils/WebSocketManager';
import { observer as globalObserver } from '../../utils/observer';
import { doUntilDone, socket_state } from '../tradeEngine/utils/helpers';
import {
    CONNECTION_STATUS,
    setAccountList,
    setAuthData,
    setConnectionStatus,
    setIsAuthorized,
    setIsAuthorizing,
} from './observables/connection-status-stream';
import { AuthSessionManager } from '@/utils/AuthSessionManager';
import chart_api from './chart-api';

type CurrentSubscription = {
    id: string;
    unsubscribe: () => void;
};

type SubscriptionPromise = Promise<{
    subscription: CurrentSubscription;
}>;

type TApiBaseApi = {
    connection: {
        readyState: keyof typeof socket_state;
        addEventListener: (event: string, callback: () => void) => void;
        removeEventListener: (event: string, callback: () => void) => void;
    };
    send: (data: unknown) => void;
    disconnect: () => void;
    authorize: (token: string) => Promise<{ authorize: TAuthData; error: unknown }>;
    getSelfExclusion: () => Promise<unknown>;
    onMessage: () => {
        subscribe: (callback: (message: unknown) => void) => {
            unsubscribe: () => void;
        };
    };
};

class APIBase {
    api: TApiBaseApi | null = null;
    token: string = '';
    account_id: string = '';
    pip_sizes = {};
    account_info = {};
    is_running = false;
    subscriptions: CurrentSubscription[] = [];
    time_interval: ReturnType<typeof setInterval> | null = null;
    has_active_symbols = false;
    is_stopping = false;
    active_symbols = [];
    current_auth_subscriptions: SubscriptionPromise[] = [];
    is_authorized = false;
    active_symbols_promise: Promise<void> | null = null;
    common_store: CommonStore | undefined;
    landing_company: string | null = null;

    private _wsEventUnsubs: Array<() => void> = [];

    unsubscribeAllSubscriptions = () => {
        this.current_auth_subscriptions?.forEach(subscription_promise => {
            subscription_promise.then(({ subscription }) => {
                if (subscription?.id) {
                    this.api?.send({
                        forget: subscription.id,
                    });
                }
            });
        });
        this.current_auth_subscriptions = [];
    };

    getConnectionStatus() {
        if (WebSocketManager.isConnected()) return 'open';
        return 'Socket not initialized';
    }

    terminate() {
        WebSocketManager.disconnect();
    }

    async init(force_create_connection = false) {
        this.toggleRunButton(true);
        this.unsubscribeAllSubscriptions();
        this._detachWsEvents();

        // Ensure ONE shared connection exists.
        // If forcing a new connection, disconnect first so WebSocketManager reconnects.
        if (force_create_connection && WebSocketManager.isConnected()) {
            WebSocketManager.disconnect();
        }

        await WebSocketManager.connect();
        this.api = WebSocketManager.getApi() as unknown as TApiBaseApi;

        // Active symbols are public market data — always fetch immediately,
        // regardless of authentication state.
        if (!this.has_active_symbols) {
            this.active_symbols_promise = this.getActiveSymbols();
        }

        this._attachWsEvents();

        if (this.time_interval) clearInterval(this.time_interval);
        this.time_interval = null;

        // Phase 2 fix: canonical-auth fallback.
        // Primary gate is AccountModeController (set by App.tsx or Login button).
        // Fallback: if canonical auth exists (access token in storage) but account
        // mode was not explicitly enabled — e.g. the page reloaded before App.tsx's
        // useEffect ran — self-heal by enabling account mode and authorizing.
        // This prevents the split-brain state where credentials exist but no WS
        // auth is ever attempted.
        const { accessToken: asmFallbackToken } = AuthSessionManager.getAuthInfo();
        const shouldAuthorize = AccountModeController.isAccountModeActive() || !!asmFallbackToken;

        if (shouldAuthorize) {
            if (!AccountModeController.isAccountModeActive()) {
                console.log('[api-base] Canonical access token found but account mode inactive — self-healing');
                AccountModeController.enableAccountMode();
            }
            setIsAuthorizing(true);
            await this.authorizeAndSubscribe();
        }

        chart_api.init();
    }

    private _attachWsEvents() {
        this._detachWsEvents();

        const unsubConnected = EventBus.on('ws:connected', () => {
            setConnectionStatus(CONNECTION_STATUS.OPENED);
            // Re-authorize on reconnect when account mode is active OR when
            // canonical auth exists (self-heal same as init()).
            const { accessToken: reconnectToken } = AuthSessionManager.getAuthInfo();
            const shouldReauth = (AccountModeController.isAccountModeActive() || !!reconnectToken) && !this.is_authorized;
            if (shouldReauth) {
                if (!AccountModeController.isAccountModeActive()) {
                    AccountModeController.enableAccountMode();
                }
                this.api = WebSocketManager.getApi() as unknown as TApiBaseApi;
                setIsAuthorizing(true);
                this.authorizeAndSubscribe().catch(() => {});
            }
        });

        const unsubDisconnected = EventBus.on('ws:disconnected', () => {
            setConnectionStatus(CONNECTION_STATUS.CLOSED);
            this.is_authorized = false;
            setIsAuthorized(false);
            AuthSessionManager.setWsAuthorized(false, null);
        });

        this._wsEventUnsubs = [unsubConnected, unsubDisconnected];

        if (window) {
            window.addEventListener('online', this._handleNetworkChange);
            window.addEventListener('focus', this._handleNetworkChange);
        }
    }

    private _detachWsEvents() {
        this._wsEventUnsubs.forEach(fn => fn());
        this._wsEventUnsubs = [];
        if (window) {
            window.removeEventListener('online', this._handleNetworkChange);
            window.removeEventListener('focus', this._handleNetworkChange);
        }
    }

    private _handleNetworkChange = () => {
        if (!WebSocketManager.isConnected()) {
            WebSocketManager.connect().catch(e =>
                console.error('[api-base] Network reconnect failed:', e)
            );
        }
    };

    async createNewInstance(account_id: string) {
        if (this.account_id !== account_id) {
            await this.init();
        }
    }

    /**
     * Populate account list and mark as authorized using data stored in localStorage
     * by the callback page (fetched from the DO backend /api/auth/accounts at login time).
     * Used as fallback when the new WS endpoint rejects the authorize() call.
     */
    _populateFromRestAccounts() {
        try {
            const raw = localStorage.getItem('clientAccounts');
            if (!raw) return false;
            const clientAccounts = JSON.parse(raw) as Record<
                string,
                { loginid: string; token: string; currency: string; account_type?: string; balance?: number }
            >;
            const accountListArr = Object.values(clientAccounts).map(acc => ({
                loginid: acc.loginid,
                currency: acc.currency || 'USD',
                account_type: acc.account_type || 'real',
                balance: acc.balance ?? 0,
                is_disabled: 0,
                is_virtual: (acc.account_type === 'demo' || acc.account_type === 'virtual') ? 1 : 0,
                token: acc.token,
            }));
            if (!accountListArr.length) return false;

            const storedLoginId = AuthSessionManager.getAuthInfo().accountId ?? '';
            const activeAcc =
                accountListArr.find(a => a.loginid === storedLoginId) ?? accountListArr[0];

            const syntheticAuthData = {
                loginid: activeAcc.loginid,
                account_list: accountListArr,
                balance: activeAcc.balance,
                currency: activeAcc.currency,
                is_virtual: activeAcc.is_virtual,
                country: localStorage.getItem('client.country') ?? '',
                email: '',
                fullname: '',
                landing_company_fullname: '',
                landing_company_name: activeAcc.loginid.match(/^VRT/i) ? 'virtual' : 'svg',
                linked_to: [],
                local_currencies: {},
                preferred_language: 'EN',
                scopes: [],
                upgradeable_landing_companies: [],
            } as unknown as TAuthData;

            setAuthData(syntheticAuthData);
            setAccountList(accountListArr as unknown as TAuthData['account_list']);
            setIsAuthorized(true);
            AuthSessionManager.setWsAuthorized(true, syntheticAuthData);
            this.is_authorized = true;
            this.account_id = activeAcc.loginid;
            this.toggleRunButton(false);
            console.log('[api-base] Populated from REST. activeLoginid =', activeAcc.loginid);
            return true;
        } catch (e) {
            console.error('[api-base] _populateFromRestAccounts failed:', e);
            return false;
        }
    }

    async authorizeAndSubscribe() {
        // Use the OTP token embedded in the WS URL (already connected via WebSocketManager).
        // Fall back to the raw authToken when no OTP was obtained.
        const otpToken = WebSocketManager.wasLastConnectionOtp()
            ? WebSocketManager.getPendingOtpToken()
            : null;
        const { accessToken: asmToken, accountId: asmAccountId } = AuthSessionManager.getAuthInfo();
        const token = otpToken || asmToken;

        // [AUTH 14] What token type are we authorizing with?
        const maskTok = (t: string | null | undefined) =>
            !t ? '(none)' : t.length <= 12 ? t.slice(0, 4) + '…' : `${t.slice(0, 8)}…${t.slice(-4)}`;

        // [CONFLICT LOG] Compare AuthSessionManager value to raw localStorage directly.
        const rawLsToken = localStorage.getItem('authToken');
        const rawLsLoginid = localStorage.getItem('active_loginid');
        if (rawLsToken !== asmToken) {
            console.warn('[AUTH-CONFLICT][api-base.authorizeAndSubscribe] authToken MISMATCH',
                '| localStorage.authToken:', maskTok(rawLsToken),
                '| AuthSessionManager.accessToken:', maskTok(asmToken),
            );
        }
        if (rawLsLoginid !== asmAccountId) {
            console.warn('[AUTH-CONFLICT][api-base.authorizeAndSubscribe] active_loginid MISMATCH',
                '| localStorage.active_loginid:', rawLsLoginid ?? '(null)',
                '| AuthSessionManager.accountId:', asmAccountId ?? '(null)',
            );
        }

        console.log('[AUTH 14][api-base.authorizeAndSubscribe] Token selection:',
            '| wasLastConnectionOtp:', WebSocketManager.wasLastConnectionOtp(),
            '| otpToken:', maskTok(otpToken),
            '| asmToken:', maskTok(asmToken),
            '| USING:', otpToken ? 'OTP token' : 'ASM token',
            '| selectedToken:', maskTok(token),
            '| api ready:', !!this.api,
        );

        if (!token || !this.api) {
            console.warn('[AUTH 14][api-base.authorizeAndSubscribe] ABORTING — no token or no api instance',
                '| hasToken:', !!token, '| hasApi:', !!this.api);
            return;
        }

        this.token = token;
        this.account_id = asmAccountId ?? '';
        setIsAuthorizing(true);
        setIsAuthorized(false);
        AuthSessionManager.setWsAuthorized(false, null);

        console.log('[AUTH 14][api-base.authorizeAndSubscribe] → Sending authorize payload',
            '| account_id:', this.account_id || '(empty)',
            '| token:', maskTok(this.token),
        );

        try {
            const { authorize, error } = await this.api.authorize(this.token);

            if (error) {
                const errCode = (error as { code?: string })?.code;
                const errMsg  = (error as { message?: string })?.message;
                console.error('[AUTH 15][api-base.authorizeAndSubscribe] ← authorize FAILED',
                    '| code:', errCode, '| message:', errMsg,
                    '| tokenType:', otpToken ? 'OTP' : 'raw',
                );

                if (errCode === 'InvalidToken') {
                    if (otpToken) {
                        console.warn('[AUTH 15][api-base] InvalidToken on OTP — falling back to REST account data');
                        const populated = this._populateFromRestAccounts();
                        if (populated) {
                            if (!this.has_active_symbols) {
                                this.active_symbols_promise = this.getActiveSymbols();
                            }
                            this.subscribe().catch(() => {});
                        }
                    } else {
                        // Raw token rejected — use canonical AuthSessionManager as source of truth.
                        // TMB check removed; recovery uses REST account data if available.
                        const asmHasToken = !!AuthSessionManager.getAuthInfo().accessToken;
                        console.warn('[AUTH 15][api-base] InvalidToken on raw token | asmHasToken:', asmHasToken);
                        if (asmHasToken) {
                            console.warn('[AUTH 15][api-base] WS authorize() rejected raw token — populating from REST data');
                            const populated = this._populateFromRestAccounts();
                            if (!populated) {
                                // REST data unavailable — clear credentials so the user can re-login cleanly.
                                console.warn('[AUTH 15][api-base] REST fallback failed — clearing auth data');
                                clearAuthData();
                            }
                        } else {
                            clearAuthData();
                        }
                    }
                } else {
                    console.error('[AUTH 15][api-base] Authorization error (non-InvalidToken):', error);
                }
                setIsAuthorizing(false);
                return;
            }

            // Success
            console.log('[AUTH 15][api-base.authorizeAndSubscribe] ← authorize SUCCESS',
                '| loginid:', authorize?.loginid,
                '| accounts:', authorize?.account_list?.length ?? 0,
                '| currency:', authorize?.currency,
                '| balance:', authorize?.balance,
            );

            this.account_info = authorize;

            // Sync loginid from WS authorize() response when it was not yet
            // stored (accounts fetch failed on the callback page — token-only
            // state with no active_loginid in localStorage).
            if (authorize.loginid) {
                const currentId = AuthSessionManager.getAuthInfo().accountId;
                if (!currentId) {
                    console.log('[AUTH 15][api-base] Populating loginid from WS authorize response:', authorize.loginid);
                    AuthSessionManager.setActiveAccount(authorize.loginid, this.token);
                }
            }

            // The new Deriv trading API at api.derivws.com sometimes returns an
            // empty account_list in the authorize response (unlike the legacy
            // WebSocket API v3 which always included it).  When that happens the
            // account-switcher becomes invisible because useActiveAccount can't
            // match any entry against activeLoginid.
            //
            // Recovery order:
            //   1. Use the WS account_list when it has entries (normal case).
            //   2. Reconstruct from the clientAccounts map written by callback-page.tsx.
            //   3. Last resort: build a minimal single-entry list from the top-level
            //      authorize fields (loginid / currency / is_virtual / etc.).
            let resolvedAccountList: TAuthData['account_list'] = authorize?.account_list || [];

            if (resolvedAccountList.length === 0 && authorize.loginid) {
                console.log('[api-base] authorize returned empty account_list — attempting REST reconstruction');
                try {
                    const raw = localStorage.getItem('clientAccounts');
                    if (raw) {
                        const parsed = JSON.parse(raw) as Record<string, {
                            loginid: string; token: string; currency: string;
                            account_type?: string; balance?: number;
                        }>;
                        const arr = Object.values(parsed).map(acc => ({
                            loginid: acc.loginid,
                            currency: acc.currency || 'USD',
                            account_type: acc.account_type || 'real',
                            is_virtual: (acc.account_type === 'demo' || acc.account_type === 'virtual') ? 1 : 0,
                            is_disabled: 0,
                            landing_company_name: /^VRT/i.test(acc.loginid) ? 'virtual' : 'svg',
                        }));
                        if (arr.length) {
                            resolvedAccountList = arr as unknown as TAuthData['account_list'];
                            console.log('[api-base] account_list reconstructed from REST data, count:', arr.length);
                        }
                    }
                } catch (_) { /* ignore parse errors */ }

                if (resolvedAccountList.length === 0) {
                    // Minimal entry built from authorize response top-level fields
                    resolvedAccountList = [{
                        loginid: authorize.loginid,
                        currency: authorize.currency || 'USD',
                        account_type: authorize.is_virtual ? 'demo' : 'real',
                        is_virtual: authorize.is_virtual || 0,
                        is_disabled: 0,
                        landing_company_name: authorize.landing_company_name || 'svg',
                    }] as unknown as TAuthData['account_list'];
                    console.log('[api-base] account_list built from authorize response fields for loginid:', authorize.loginid);
                }
            }

            const authorizeWithList = resolvedAccountList !== (authorize?.account_list || [])
                ? { ...authorize, account_list: resolvedAccountList }
                : authorize;

            setAccountList(resolvedAccountList);
            setAuthData(authorizeWithList);
            setIsAuthorized(true);
            AuthSessionManager.setWsAuthorized(true, authorizeWithList);
            this.is_authorized = true;
            localStorage.setItem('client_account_details', JSON.stringify(resolvedAccountList));
            localStorage.setItem('client.country', authorize?.country);

            if (this.has_active_symbols) {
                this.toggleRunButton(false);
            } else {
                this.active_symbols_promise = this.getActiveSymbols();
            }
            this.subscribe();
        } catch (e) {
            console.error('[AUTH 15][api-base.authorizeAndSubscribe] authorize() threw:', e);
            this.is_authorized = false;
            if (!AuthSessionManager.getAuthInfo().accessToken) {
                clearAuthData();
            }
            setIsAuthorized(false);
            AuthSessionManager.setWsAuthorized(false, null);
            globalObserver.emit('Error', e);
        } finally {
            setIsAuthorizing(false);
        }
    }

    async getSelfExclusion() {
        if (!this.api || !this.is_authorized) return;
        await this.api.getSelfExclusion();
    }

    async subscribe() {
        const subscribeToStream = (streamName: string) => {
            return doUntilDone(
                () => {
                    const subscription = this.api?.send({
                        [streamName]: 1,
                        subscribe: 1,
                        ...(streamName === 'balance' ? { account: 'all' } : {}),
                    });
                    if (subscription) {
                        this.current_auth_subscriptions.push(subscription);
                    }
                    return subscription;
                },
                [],
                this
            );
        };

        const streamsToSubscribe = ['balance', 'transaction', 'proposal_open_contract'];
        await Promise.all(streamsToSubscribe.map(subscribeToStream));
    }

    getActiveSymbols = async () => {
        await doUntilDone(() => this.api?.send({ active_symbols: 'brief' }), [], this).then(
            ({ active_symbols = [], error = {} }) => {
                // The new trading API at api.derivws.com uses different field names than
                // the standard Deriv WebSocket API v3. Normalize here so all downstream
                // consumers (active-symbols.js processActiveSymbols, pip_sizes, etc.)
                // continue to work with the expected field names.
                //
                // New API → Old API mapping:
                //   underlying_symbol      → symbol
                //   underlying_symbol_name → display_name
                //   pip_size (integer)     → pip (string like "0.01")
                //   market_display_name    → derived from market code if absent
                //   submarket_display_name → derived from submarket code if absent
                const toDisplayName = (code: string): string =>
                    code ? code.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : '';

                const normalized = (active_symbols as any[]).map((s: any) => {
                    const symbol = s.underlying_symbol ?? s.symbol;
                    const pip_size_int: number | undefined = s.pip_size;
                    // Convert integer pip_size (e.g. 2) to old-style pip string (e.g. "0.01").
                    const pip: string =
                        s.pip ??
                        (pip_size_int != null ? (10 ** -pip_size_int).toFixed(pip_size_int) : '0');
                    return {
                        ...s,
                        symbol,
                        display_name: s.underlying_symbol_name ?? s.display_name,
                        market_display_name: s.market_display_name ?? toDisplayName(s.market),
                        submarket_display_name:
                            s.submarket_display_name ?? toDisplayName(s.submarket),
                        pip,
                    };
                });

                const pip_sizes: Record<string, number> = {};
                if (normalized.length) this.has_active_symbols = true;
                normalized.forEach(({ symbol, pip }: { symbol: string; pip: string }) => {
                    pip_sizes[symbol] = +(+pip).toExponential().substring(3);
                });
                this.pip_sizes = pip_sizes;
                this.toggleRunButton(false);
                this.active_symbols = normalized;
                // Signal all waiters (active-symbols.js init_promise, Blockly blocks)
                // that symbols are now available.
                console.log('[api-base] active_symbols loaded — count:', normalized.length);
                EventBus.emit('active_symbols:loaded');
                return normalized || error;
            }
        );
    };

    toggleRunButton = (toggle: boolean) => {
        const run_button = document.querySelector('#db-animation__run-button');
        if (!run_button) return;
        (run_button as HTMLButtonElement).disabled = toggle;
    };

    setIsRunning(toggle = false) {
        this.is_running = toggle;
    }

    pushSubscription(subscription: CurrentSubscription) {
        this.subscriptions.push(subscription);
    }

    clearSubscriptions() {
        this.subscriptions.forEach(s => s.unsubscribe());
        this.subscriptions = [];

        const global_timeouts = globalObserver.getState('global_timeouts') ?? [];
        global_timeouts.forEach((_: unknown, i: number) => {
            clearTimeout(i);
        });
    }
}

export const api_base = new APIBase();
