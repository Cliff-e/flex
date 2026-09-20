/**
 * VPS Bot Manager — `/vps-bots`.
 *
 * A separate, additive page. It does not touch the Bot Builder, the XML editor,
 * or any existing trading UI: the only shared integration point is its route.
 *
 * The workflow the page makes obvious is:
 *
 *     UPLOAD XML  →  DEPLOY  →  START BOT  →  monitor  →  STOP / RESTART
 *
 * Every status shown comes from the backend (PM2's process state and the
 * runtime's `stats.json`). Nothing is optimistically faked: after an action the
 * page re-reads the server's view rather than assuming success, and a bot is
 * never shown as running unless PM2 says it is.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { localize } from '@deriv-com/translations';
import { initiateDerivAuth } from '@/utils/pkce';
import vpsBotApi, { VpsBotApiError, type VpsBot, type VpsBotLimits, type VpsBotLogsResponse } from './apiClient';
import './vps-bot-manager.scss';

const POLL_INTERVAL_MS = 5_000;

/** Every status the UI can show, derived from server state. */
type UiStatus =
    | 'Not Deployed'
    | 'Deploying'
    | 'Running'
    | 'Stopped'
    | 'Errored'
    | 'Offline'
    | 'Deployment Failed'
    | 'Authentication Expired';

const STATUS_TONE: Record<UiStatus, string> = {
    'Not Deployed': 'idle',
    Deploying: 'pending',
    Running: 'ok',
    Stopped: 'idle',
    Errored: 'bad',
    Offline: 'idle',
    'Deployment Failed': 'bad',
    'Authentication Expired': 'warn',
};

/**
 * Maps server state onto one UI status.
 *
 * Order matters: an expired credential is reported before "running", because a
 * bot whose authentication has lapsed is not doing anything useful even if its
 * process is still up.
 */
export function deriveStatus(bot: VpsBot): UiStatus {
    const stats = bot.stats?.status ?? null;

    if (stats === 'expired') return 'Authentication Expired';
    if (stats === 'error') return bot.process.managed ? 'Errored' : 'Deployment Failed';

    if (bot.deployment.status !== 'deployed') return 'Not Deployed';

    if (!bot.process.managed) return 'Stopped';

    switch (bot.process.status) {
        case 'online':
            return stats === 'starting' ? 'Deploying' : 'Running';
        case 'stopped':
            return 'Stopped';
        case 'launching':
        case 'starting':
            return 'Deploying';
        case 'errored':
            return 'Errored';
        default:
            return 'Offline';
    }
}

function formatProfit(profit: number, currency: string | null): string {
    const sign = profit > 0 ? '+' : '';
    const symbol = !currency || currency === 'USD' ? '$' : '';
    return symbol ? `${sign}${symbol}${profit.toFixed(2)}` : `${sign}${profit.toFixed(2)} ${currency}`;
}

function formatUptime(seconds: number): string {
    if (!seconds) return '—';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}
const VpsBotManager = () => {
    const [bots, setBots] = useState<VpsBot[]>([]);
    const [limits, setLimits] = useState<VpsBotLimits | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [authExpired, setAuthExpired] = useState(false);

    const [botName, setBotName] = useState('');
    const [xmlText, setXmlText] = useState('');
    const [fileName, setFileName] = useState('');
    const [logsFor, setLogsFor] = useState<string | null>(null);
    const [logs, setLogs] = useState<VpsBotLogsResponse | null>(null);

    const fileInput = useRef<HTMLInputElement | null>(null);

    const applyError = useCallback((err: unknown) => {
        if (err instanceof VpsBotApiError && err.isAuthenticationError) {
            setAuthExpired(true);
            setError(err.message);
            return;
        }
        setError(err instanceof Error ? err.message : 'The request failed.');
    }, []);

    const refresh = useCallback(async () => {
        try {
            const data = await vpsBotApi.list();
            setBots(data.bots);
            setLimits(data.limits);
            setAuthExpired(false);
            setError(null);
        } catch (err) {
            applyError(err);
        } finally {
            setLoading(false);
        }
    }, [applyError]);

    useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [refresh]);

    /** Runs an action, then re-reads the server's view of every bot. */
    const runAction = useCallback(
        async (label: string, action: () => Promise<unknown>) => {
            setBusy(label);
            setError(null);
            try {
                await action();
            } catch (err) {
                applyError(err);
            } finally {
                await refresh();
                setBusy(null);
            }
        },
        [applyError, refresh],
    );

    const onFileChange = useCallback(async (file: File | undefined) => {
        if (!file) return;
        try {
            const text = await file.text();
            setXmlText(text);
            setFileName(file.name);
            setBotName(current => (current.trim() === '' ? file.name.replace(/\.xml$/i, '') : current));
            setError(null);
        } catch {
            setError('That file could not be read.');
        }
    }, []);

    const onUpload = useCallback(async () => {
        if (xmlText.trim() === '') {
            setError('Choose an XML strategy file first.');
            return;
        }
        await runAction('upload', async () => {
            await vpsBotApi.upload(botName.trim() || 'Untitled bot', xmlText);
            setXmlText('');
            setFileName('');
            setBotName('');
            if (fileInput.current) fileInput.current.value = '';
        });
    }, [botName, runAction, xmlText]);

    const onShowLogs = useCallback(
        async (botId: string) => {
            setLogsFor(botId);
            setLogs(null);
            try {
                setLogs(await vpsBotApi.logs(botId, 150));
            } catch (err) {
                applyError(err);
                setLogsFor(null);
            }
        },
        [applyError],
    );

    const atCapacity = useMemo(() => (limits ? limits.usedBots >= limits.maxBots : false), [limits]);


    return (
        <div className='vps-bots'>
            <header className='vps-bots__header'>
                <h1 className='vps-bots__title'>{localize('VPS Bots')}</h1>
                <p className='vps-bots__subtitle'>
                    {localize(
                        'Upload a strategy, deploy it to the server, and it keeps trading without this browser.',
                    )}
                </p>
                {limits && (
                    <p className='vps-bots__capacity'>
                        {localize('Bots')}: {limits.usedBots} / {limits.maxBots}
                    </p>
                )}
            </header>

            {authExpired && (
                <div className='vps-bots__banner vps-bots__banner--warn' role='alert'>
                    <span>{localize('Your Deriv session has expired.')}</span>
                    <button type='button' className='vps-bots__btn' onClick={() => void initiateDerivAuth()}>
                        {localize('Re-authenticate')}
                    </button>
                </div>
            )}

            {error && !authExpired && (
                <div className='vps-bots__banner vps-bots__banner--bad' role='alert'>
                    {error}
                </div>
            )}

            <section className='vps-bots__panel'>
                <h2 className='vps-bots__panel-title'>{localize('1. Upload a strategy')}</h2>
                <div className='vps-bots__form'>
                    <label className='vps-bots__field'>
                        <span>{localize('Bot name')}</span>
                        <input
                            type='text'
                            value={botName}
                            maxLength={60}
                            placeholder={localize('My Volatility Bot')}
                            onChange={event => setBotName(event.target.value)}
                        />
                    </label>
                    <label className='vps-bots__field'>
                        <span>{localize('Strategy XML')}</span>
                        <input
                            ref={fileInput}
                            type='file'
                            accept='.xml,application/xml,text/xml'
                            onChange={event => void onFileChange(event.target.files?.[0])}
                        />
                    </label>
                    <button
                        type='button'
                        className='vps-bots__btn vps-bots__btn--primary'
                        disabled={busy !== null || atCapacity}
                        onClick={() => void onUpload()}
                    >
                        {busy === 'upload' ? localize('Uploading…') : localize('Upload XML')}
                    </button>
                    {fileName && <span className='vps-bots__hint'>{fileName}</span>}
                    {atCapacity && (
                        <span className='vps-bots__hint vps-bots__hint--warn'>
                            {localize('This server is at capacity. Remove a bot to free a slot.')}
                        </span>
                    )}
                </div>
            </section>

            <section className='vps-bots__panel'>
                <h2 className='vps-bots__panel-title'>{localize('2. Deploy, then start')}</h2>

                {loading && <p className='vps-bots__hint'>{localize('Loading bots…')}</p>}
                {!loading && bots.length === 0 && (
                    <p className='vps-bots__hint'>{localize('No bots yet. Upload a strategy to begin.')}</p>
                )}



                <div className='vps-bots__grid'>
                    {bots.map(bot => {
                        const status = deriveStatus(bot);
                        const stats = bot.stats;
                        const tone = STATUS_TONE[status];
                        return (
                            <article key={bot.botId} className='vps-bot-card'>
                                <div className='vps-bot-card__head'>
                                    <h3 className='vps-bot-card__name'>{bot.name}</h3>
                                    <span className='vps-bot-card__id'>{bot.botId}</span>
                                </div>

                                <div className={`vps-bot-card__status vps-bot-card__status--${tone}`}>
                                    <span className='vps-bot-card__dot' aria-hidden='true' />
                                    {status}
                                </div>

                                <dl className='vps-bot-card__stats'>
                                    <div>
                                        <dt>{localize('Trades')}</dt>
                                        <dd>{stats?.trades ?? 0}</dd>
                                    </div>
                                    <div>
                                        <dt>{localize('Wins')}</dt>
                                        <dd>{stats?.wins ?? 0}</dd>
                                    </div>
                                    <div>
                                        <dt>{localize('Losses')}</dt>
                                        <dd>{stats?.losses ?? 0}</dd>
                                    </div>
                                    <div>
                                        <dt>{localize('Profit')}</dt>
                                        <dd>{formatProfit(stats?.profit ?? 0, stats?.currency ?? null)}</dd>
                                    </div>
                                    <div>
                                        <dt>{localize('Uptime')}</dt>
                                        <dd>{formatUptime(stats?.uptimeSeconds ?? 0)}</dd>
                                    </div>
                                    <div>
                                        <dt>{localize('Restarts')}</dt>
                                        <dd>{bot.process.restarts}</dd>
                                    </div>
                                </dl>

                                {stats?.error && <p className='vps-bot-card__error'>{stats.error}</p>}


                                <div className='vps-bot-card__actions'>
                                    {bot.deployment.status !== 'deployed' ? (
                                        <button
                                            type='button'
                                            className='vps-bots__btn vps-bots__btn--primary'
                                            disabled={busy !== null}
                                            onClick={() =>
                                                void runAction(`${bot.botId}:deploy`, () => vpsBotApi.deploy(bot.botId))
                                            }
                                        >
                                            {localize('Deploy')}
                                        </button>
                                    ) : (
                                        <>
                                            <button
                                                type='button'
                                                className='vps-bots__btn vps-bots__btn--primary'
                                                disabled={busy !== null}
                                                onClick={() =>
                                                    void runAction(`${bot.botId}:start`, () => vpsBotApi.start(bot.botId))
                                                }
                                            >
                                                {localize('Start')}
                                            </button>
                                            <button
                                                type='button'
                                                className='vps-bots__btn'
                                                disabled={busy !== null}
                                                onClick={() =>
                                                    void runAction(`${bot.botId}:stop`, () => vpsBotApi.stop(bot.botId))
                                                }
                                            >
                                                {localize('Stop')}
                                            </button>
                                            <button
                                                type='button'
                                                className='vps-bots__btn'
                                                disabled={busy !== null}
                                                onClick={() =>
                                                    void runAction(`${bot.botId}:restart`, () =>
                                                        vpsBotApi.restart(bot.botId),
                                                    )
                                                }
                                            >
                                                {localize('Restart')}
                                            </button>
                                        </>
                                    )}
                                    <button
                                        type='button'
                                        className='vps-bots__btn'
                                        disabled={busy !== null}
                                        onClick={() => void onShowLogs(bot.botId)}
                                    >
                                        {localize('Logs')}
                                    </button>
                                    <button
                                        type='button'
                                        className='vps-bots__btn vps-bots__btn--danger'
                                        disabled={busy !== null}
                                        onClick={() =>
                                            void runAction(`${bot.botId}:remove`, () => vpsBotApi.remove(bot.botId))
                                        }
                                    >
                                        {localize('Remove')}
                                    </button>
                                </div>
                            </article>
                        );
                    })}
                </div>
            </section>


            {logsFor && (
                <section className='vps-bots__panel'>
                    <div className='vps-bots__panel-head'>
                        <h2 className='vps-bots__panel-title'>
                            {localize('Logs')} · {logsFor}
                        </h2>
                        <button type='button' className='vps-bots__btn' onClick={() => setLogsFor(null)}>
                            {localize('Close')}
                        </button>
                    </div>

                    {!logs && <p className='vps-bots__hint'>{localize('Loading logs…')}</p>}

                    {logs && (
                        <>
                            {logs.truncated && (
                                <p className='vps-bots__hint vps-bots__hint--warn'>
                                    {localize('Showing the most recent lines only.')}
                                </p>
                            )}
                            <pre className='vps-bots__logs'>{logs.stdout || localize('(no output yet)')}</pre>
                            {logs.stderr && <pre className='vps-bots__logs vps-bots__logs--err'>{logs.stderr}</pre>}
                        </>
                    )}
                </section>
            )}
        </div>
    );
};

export default VpsBotManager;
