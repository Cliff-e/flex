/**
 * Client for the VPS bot API.
 *
 * SECURITY NOTE
 * -------------
 * The browser's Deriv access token is sent ONLY as an `Authorization: Bearer`
 * header - never in a URL, never in a body, never stored by this module. It is
 * read from `AuthSessionManager` (the single owner of that credential) at the
 * moment a request is made and is not retained anywhere else.
 *
 * Nothing in this file logs a token, and no response field is echoed to the
 * console: the backend is designed never to return a credential, and this client
 * does not create a second opportunity for one to leak.
 */

import { AuthSessionManager } from '@/utils/AuthSessionManager';
import { API_BASE_URL } from '@/utils/pkce';

export type VpsBotStats = {
    status: string;
    startedAt: string | null;
    lastActivityAt: string | null;
    lastTradeAt: string | null;
    trades: number;
    wins: number;
    losses: number;
    profit: number;
    currency: string | null;
    uptimeSeconds: number;
    error: string | null;
};

export type VpsBotProcess = {
    managed: boolean;
    status: string;
    pid: number | null;
    restarts: number;
    uptimeMs: number | null;
    memoryBytes: number | null;
};

export type VpsBot = {
    botId: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    deployment: { status: 'uploaded' | 'deployed'; deployedAt: string | null };
    process: VpsBotProcess;
    stats: VpsBotStats | null;
    accountId: string | null;
};

export type VpsBotLimits = { maxBots: number; usedBots: number };

export type VpsBotListResponse = { bots: VpsBot[]; limits: VpsBotLimits };
export type VpsBotResponse = { bot: VpsBot; limits: VpsBotLimits };
export type VpsBotLogsResponse = {
    botId: string;
    lines: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
};

/** An error carrying the backend's machine-readable code. */
export class VpsBotApiError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = 'VpsBotApiError';
        this.status = status;
        this.code = code;
    }

    /** True when the session must be re-established. */
    get isAuthenticationError(): boolean {
        return this.status === 401;
    }
}

function requireBaseUrl(): string {
    if (!API_BASE_URL) {
        throw new VpsBotApiError(
            0,
            'backend_not_configured',
            'VITE_API_BASE_URL is not configured, so the bot manager cannot reach the backend.',
        );
    }
    return API_BASE_URL;
}

/**
 * Builds the request headers, including the bearer token when one is available.
 *
 * The token is read here and used immediately; it is never assigned to a module
 * or component field.
 */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const { accessToken } = AuthSessionManager.getAuthInfo();
    const headers: Record<string, string> = { ...extra };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return headers;
}

async function call<T>(route: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${requireBaseUrl()}${route}`, init);

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let payload: unknown = null;
    if (text !== '') {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = null;
        }
    }

    if (!response.ok) {
        const error = (payload ?? {}) as { error?: string; error_description?: string };
        throw new VpsBotApiError(
            response.status,
            error.error ?? 'request_failed',
            error.error_description ?? `The request failed (${response.status}).`,
        );
    }

    return payload as T;
}

export const vpsBotApi = {
    list: (): Promise<VpsBotListResponse> => call<VpsBotListResponse>('/api/vps-bots', { headers: authHeaders() }),

    get: (botId: string): Promise<VpsBotResponse> =>
        call<VpsBotResponse>(`/api/vps-bots/${encodeURIComponent(botId)}`, { headers: authHeaders() }),

    /**
     * Uploads a strategy.
     *
     * The document is sent as `application/xml` and the display name as a query
     * parameter: the upload route owns a scoped body parser with the size limit
     * the strategies actually need, without relaxing the global JSON limit.
     */
    upload: (name: string, xml: string): Promise<VpsBotResponse> =>
        call<VpsBotResponse>(`/api/vps-bots/upload?name=${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/xml' }),
            body: xml,
        }),

    deploy: (botId: string): Promise<VpsBotResponse> =>
        call<VpsBotResponse>(`/api/vps-bots/${encodeURIComponent(botId)}/deploy`, {
            method: 'POST',
            headers: authHeaders(),
        }),

    start: (botId: string): Promise<VpsBotResponse> =>
        call<VpsBotResponse>(`/api/vps-bots/${encodeURIComponent(botId)}/start`, {
            method: 'POST',
            headers: authHeaders(),
        }),

    stop: (botId: string): Promise<VpsBotResponse> =>
        call<VpsBotResponse>(`/api/vps-bots/${encodeURIComponent(botId)}/stop`, {
            method: 'POST',
            headers: authHeaders(),
        }),

    restart: (botId: string): Promise<VpsBotResponse> =>
        call<VpsBotResponse>(`/api/vps-bots/${encodeURIComponent(botId)}/restart`, {
            method: 'POST',
            headers: authHeaders(),
        }),

    remove: (botId: string): Promise<void> =>
        call<void>(`/api/vps-bots/${encodeURIComponent(botId)}`, { method: 'DELETE', headers: authHeaders() }),

    logs: (botId: string, lines = 100): Promise<VpsBotLogsResponse> =>
        call<VpsBotLogsResponse>(`/api/vps-bots/${encodeURIComponent(botId)}/logs?lines=${lines}`, {
            headers: authHeaders(),
        }),

    stats: (botId: string): Promise<{ botId: string; stats: VpsBotStats | null }> =>
        call<{ botId: string; stats: VpsBotStats | null }>(
            `/api/vps-bots/${encodeURIComponent(botId)}/stats`,
            { headers: authHeaders() },
        ),
};

export default vpsBotApi;
