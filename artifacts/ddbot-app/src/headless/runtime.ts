/**
 * Headless bot runtime - the unit of work PM2 supervises on the VPS.
 *
 * RESPONSIBILITY
 * --------------
 *   bot.xml ──▶ existing Blockly generator ──▶ generated DBot source
 *           ──▶ existing @deriv/js-interpreter ──▶ existing TradeEngine
 *           ──▶ existing api_base ──▶ authenticated Deriv WebSocket
 *
 * It adds no new trading logic, no new Blockly generator and no new WebSocket
 * client. Everything between "read the XML" and "a real contract settles" is the
 * SAME code the Bot Builder runs in the browser; this module only wires it up,
 * supplies credentials, records statistics and shuts down cleanly on a signal.
 *
 * SECURITY RULES ENFORCED HERE
 * ----------------------------
 *   - The bot id and every filesystem path are validated, never trusted. The
 *     directory name must equal the bot id, the path must be absolute and must
 *     contain no `..` segment, and the credential file must live inside it.
 *   - The generated source is held in a local variable and is never logged,
 *     persisted or returned. It embeds the access token.
 *   - Console output is scrubbed by `installConsoleRedaction()` before PM2 can
 *     write it to a log file.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Interpreter from '../external/bot-skeleton/services/tradeEngine/utils/interpreter';
import { observer as globalObserver } from '../external/bot-skeleton/utils/observer';
import { bootHeadlessRuntime, type HeadlessRuntime } from './blocklyHeadless';
import {
    DEFAULT_DERIV_APP_ID,
    DerivConnection,
    loadCredentials,
    type DerivCredentials,
} from './derivConnection';
import { installConsoleRedaction, safeErrorText } from './redact';
import { StatsCollector, type BotState, type ContractStatusEvent } from './stats';

/** Bot ids are generated server-side and always look like `bot-001`. */
export const BOT_ID_PATTERN = /^bot-\d{3}$/;

/** Uploaded strategies are small; a 512 KiB cap is generous and bounds parsing. */
export const MAX_XML_BYTES = 512 * 1024;

/** File names inside a bot directory. */
export const BOT_XML_FILENAME = 'bot.xml';
export const BOT_STATS_FILENAME = 'stats.json';
export const BOT_CREDENTIAL_FILENAME = 'credentials.json';

export type BotRuntimeConfig = {
    botId: string;
    /** Absolute, validated directory that contains only this bot's files. */
    botDir: string;
    xmlPath: string;
    statsPath: string;
    credentialFile: string;
    derivAppId: string;
    connectTimeoutMs: number;
};

export type ConfigResult = { ok: true; config: BotRuntimeConfig } | { ok: false; error: string };

/**
 * Derives every path from `BOT_ID` + `BOT_DIR`.
 *
 * `BOT_DIR` is still validated rather than trusted: it must be absolute, free of
 * `..` segments and its final segment must be the bot id. That is what makes it
 * impossible for a caller to point the runtime at, say, the application
 * directory or `/root`.
 */
export function parseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigResult {
    const botId = (env.BOT_ID ?? '').trim();
    if (!botId) return { ok: false, error: 'BOT_ID is required' };
    if (!BOT_ID_PATTERN.test(botId)) {
        return { ok: false, error: `BOT_ID must match ${BOT_ID_PATTERN} (got a rejected value)` };
    }

    const rawDir = (env.BOT_DIR ?? '').trim();
    if (!rawDir) return { ok: false, error: 'BOT_DIR is required' };

    const normalised = path.resolve(rawDir);
    if (!path.isAbsolute(rawDir)) return { ok: false, error: 'BOT_DIR must be an absolute path' };
    if (rawDir.split(/[\\/]+/).includes('..')) return { ok: false, error: 'BOT_DIR must not contain ".."' };
    if (path.basename(normalised) !== botId) {
        return { ok: false, error: 'BOT_DIR must end with the bot id (e.g. /opt/flex-bots/bot-001)' };
    }

    const credentialFile = env.BOT_CREDENTIAL_FILE
        ? path.resolve(env.BOT_CREDENTIAL_FILE)
        : path.join(normalised, BOT_CREDENTIAL_FILENAME);

    // The credential file must stay inside the bot directory - a credential path
    // is never taken from outside the bot's own isolated tree.
    const relativeCredential = path.relative(normalised, credentialFile);
    if (relativeCredential.startsWith('..') || path.isAbsolute(relativeCredential)) {
        return { ok: false, error: 'BOT_CREDENTIAL_FILE must live inside BOT_DIR' };
    }

    const timeoutRaw = Number(env.BOT_CONNECT_TIMEOUT_MS ?? '30000');
    const connectTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 30_000;

    return {
        ok: true,
        config: {
            botId,
            botDir: normalised,
            xmlPath: path.join(normalised, BOT_XML_FILENAME),
            statsPath: path.join(normalised, BOT_STATS_FILENAME),
            credentialFile,
            derivAppId: env.DERIV_APP_ID ?? DEFAULT_DERIV_APP_ID,
            connectTimeoutMs,
        },
    };
}

// ---------------------------------------------------------------------------
// Collaborators (injectable so the runtime can be verified without a network)
// ---------------------------------------------------------------------------

export type InterpreterLike = {
    run: (code: string) => Promise<unknown>;
    stop: () => void;
    terminateSession: () => Promise<unknown>;
};

/** The subset of the runtime's custom Observer that the stats wiring needs. */
export type ObserverAction = (payload: unknown) => void;

export type ObserverLike = {
    register: (event: string, action: ObserverAction) => void;
    unregister: (event: string, action: ObserverAction) => void;
};

export type BotRuntimeDeps = {
    boot: () => Promise<HeadlessRuntime>;
    createInterpreter: () => InterpreterLike;
    createConnection: (credentials: DerivCredentials, botId: string) => DerivConnection;
    loadCredentials: typeof loadCredentials;
    observer: ObserverLike;
    now: () => number;
};

export function realRuntimeDeps(): BotRuntimeDeps {
    return {
        boot: bootHeadlessRuntime,
        createInterpreter: () => Interpreter() as unknown as InterpreterLike,
        createConnection: credentials => new DerivConnection(credentials),
        loadCredentials,
        observer: globalObserver as unknown as ObserverLike,
        now: () => Date.now(),
    };
}

/**
 * Reads and sanity-checks a bot's strategy file.
 *
 * The upstream upload endpoint validates the XML in full; this check only
 * guarantees the runtime is never handed a missing, empty or oversized file.
 */
export function readStrategyXml(xmlPath: string): { ok: true; xml: string } | { ok: false; error: string } {
    if (!existsSync(xmlPath)) return { ok: false, error: `strategy file not found (${BOT_XML_FILENAME})` };

    let size: number;
    try {
        size = statSync(xmlPath).size;
    } catch {
        return { ok: false, error: 'strategy file could not be inspected' };
    }
    if (size === 0) return { ok: false, error: 'strategy file is empty' };
    if (size > MAX_XML_BYTES) return { ok: false, error: `strategy file exceeds ${MAX_XML_BYTES} bytes` };

    let xml: string;
    try {
        xml = readFileSync(xmlPath, 'utf8');
    } catch {
        return { ok: false, error: 'strategy file could not be read' };
    }
    if (!xml.trimStart().startsWith('<')) return { ok: false, error: 'strategy file is not XML' };

    return { ok: true, xml };
}


// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

/**
 * One bot process: strategy file in, statistics file out, one Deriv connection.
 *
 * `start()` resolves with the state reached. Only `authenticated` means the
 * strategy is actually executing - for any other outcome the strategy is NOT run,
 * so a bot can never appear to be trading while unauthenticated.
 */
export class BotRuntime {
    private readonly _config: BotRuntimeConfig;
    private readonly _deps: BotRuntimeDeps;
    private readonly _stats: StatsCollector;

    private _state: BotState = 'starting';
    private _connection: DerivConnection | null = null;
    private _interpreter: InterpreterLike | null = null;
    private _stopPromise: Promise<void> | null = null;
    private _detachConsoleRedaction: (() => void) | null = null;
    private _bindings: Array<{ event: string; action: ObserverAction }> = [];

    constructor(config: BotRuntimeConfig, deps: BotRuntimeDeps = realRuntimeDeps()) {
        this._config = config;
        this._deps = deps;
        this._stats = new StatsCollector({
            botId: config.botId,
            filePath: config.statsPath,
            now: deps.now,
        });
    }

    get config(): BotRuntimeConfig {
        return this._config;
    }

    get state(): BotState {
        return this._state;
    }

    get stats(): StatsCollector {
        return this._stats;
    }

    private _transition(state: BotState, options: { error?: unknown } = {}): BotState {
        this._state = state;
        this._stats.setStatus(state, options.error === undefined ? {} : { error: options.error });
        return state;
    }

    /**
     * Boots the headless environment, generates the strategy and, if Deriv
     * authorizes, executes it through the existing trade engine.
     */
    async start(): Promise<BotState> {
        this._detachConsoleRedaction = installConsoleRedaction();
        this._stats.markStarted(this._deps.now());
        this._stats.setStatus('starting');
        this._stats.startAutoFlush();

        // eslint-disable-next-line no-console
        console.log(`[bot-runtime] ${this._config.botId} starting | dir=${this._config.botDir}`);

        const strategy = readStrategyXml(this._config.xmlPath);
        if (!strategy.ok) return this._fail('error', strategy.error);

        const loaded = this._deps.loadCredentials({
            credentialFile: this._config.credentialFile,
            appId: this._config.derivAppId,
        });
        if (!loaded.ok) {
            // No usable credential: only the user can fix this, so report the
            // state that drives the UI's [Re-authenticate] action.
            return this._fail('expired', loaded.reason);
        }
        const credentials = loaded.credentials;

        let code: string;
        try {
            const runtime = await this._deps.boot();
            runtime.setAccountContext({
                currency: credentials.currency ?? 'USD',
                loginid: credentials.accountId,
                accessToken: credentials.accessToken,
            });
            // SECRET: the generated source embeds the access token. It stays in
            // this local variable - never logged, never persisted, never returned.
            code = runtime.xmlToCode(strategy.xml);
        } catch (error) {
            return this._fail('error', `strategy could not be generated: ${safeErrorText(error)}`);
        }
        if (!code || code.length < 200) return this._fail('error', 'code generation produced no usable output');

        const connection = this._deps.createConnection(credentials, this._config.botId);
        this._connection = connection;
        connection.onStateChange((state, detail) => {
            const options = state === 'error' || state === 'expired' ? { error: detail } : {};
            this._transition(state, options);
        });

        const connected = await connection.connect({ timeoutMs: this._config.connectTimeoutMs });
        if (connected !== 'authenticated') {
            // Never execute a strategy against an unauthenticated connection.
            this._stats.dispose();
            return connected;
        }

        this._bindObserver();
        return this._runStrategy(code);
    }

    private _runStrategy(code: string): BotState {
        const interpreter = this._deps.createInterpreter();
        this._interpreter = interpreter;

        // eslint-disable-next-line no-console
        console.log(`[bot-runtime] ${this._config.botId} strategy started`);

        void interpreter
            .run(code)
            .then(() => {
                // The interpreter resolved: the strategy ended on its own.
                if (this._state === 'stopping' || this._state === 'stopped') return;
                this._transition('stopped');
                this._stats.dispose();
            })
            .catch((error: unknown) => {
                if (this._state === 'stopping' || this._state === 'stopped') return;
                this._fail('error', `strategy failed: ${safeErrorText(error)}`);
            });

        return this._state;
    }

    /** Records a terminal failure and flushes statistics. */
    private _fail(state: BotState, message: string): BotState {
        // eslint-disable-next-line no-console
        console.error(`[bot-runtime] ${this._config.botId} ${state}: ${message}`);
        const result = this._transition(state, { error: message });
        this._stats.dispose();
        return result;
    }

    /**
     * Binds statistics to the events the existing trade engine already emits.
     *
     * `contract.status` (id `contract.sold`, carrying a real `profit`) is the
     * ONLY thing that advances the trade counters. `bot.contract` and the UI log
     * events only refresh `lastActivityAt` - monitoring is not trading.
     */
    private _bindObserver(): void {
        const observer = this._deps.observer;

        const onContractStatus = (payload: unknown) => {
            this._stats.recordContractEvent(payload as ContractStatusEvent);
        };
        const onActivity = () => {
            this._stats.markActivity();
        };

        const bindings: Array<{ event: string; action: ObserverAction }> = [
            { event: 'contract.status', action: onContractStatus },
            { event: 'bot.contract', action: onActivity },
            { event: 'ui.log.success', action: onActivity },
            { event: 'ui.log.error', action: onActivity },
            { event: 'ui.log.warn', action: onActivity },
        ];

        for (const binding of bindings) {
            try {
                observer.register(binding.event, binding.action);
                this._bindings.push(binding);
            } catch {
                // A missing event slot must not stop the bot from running.
            }
        }
    }

    /** Removes every observer handler this runtime registered. */
    private _unbindObserver(): void {
        const bindings = this._bindings;
        this._bindings = [];
        for (const binding of bindings) {
            try {
                this._deps.observer.unregister(binding.event, binding.action);
            } catch {
                // Already gone.
            }
        }
    }

    /**
     * Graceful shutdown, in the order PM2 needs it:
     *   1. unsubscribe from the trade engine's events,
     *   2. stop strategy execution and release its subscriptions,
     *   3. close the Deriv connection,
     *   4. flush statistics and record `stopped`.
     *
     * Idempotent, and safe to call while `start()` is still connecting: the
     * connection is closed immediately, so an in-flight handshake cannot hold
     * the shutdown open.
     */
    async stop(reason: string): Promise<void> {
        if (this._stopPromise) return this._stopPromise;
        this._stopPromise = this._doStop(reason);
        return this._stopPromise;
    }

    private async _doStop(reason: string): Promise<void> {
        if (this._state === 'stopped') return;

        // eslint-disable-next-line no-console
        console.log(`[bot-runtime] ${this._config.botId} stopping | reason=${reason}`);
        this._transition('stopping');

        this._unbindObserver();

        const interpreter = this._interpreter;
        this._interpreter = null;
        if (interpreter) {
            try {
                await bounded(Promise.resolve(interpreter.stop()), 5_000);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error(`[bot-runtime] interpreter stop failed: ${safeErrorText(error)}`);
            }
        }

        const connection = this._connection;
        this._connection = null;
        if (connection) {
            try {
                await connection.close();
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error(`[bot-runtime] connection close failed: ${safeErrorText(error)}`);
            }
        }

        this._state = 'stopped';
        this._stats.setStatus('stopped');
        // Final flush: stats.json must say `stopped` even if we are about to exit.
        this._stats.dispose();

        this._detachConsoleRedaction?.();
        this._detachConsoleRedaction = null;

        // eslint-disable-next-line no-console
        console.log(`[bot-runtime] ${this._config.botId} stopped`);
    }
}


// ---------------------------------------------------------------------------
// Process wiring
// ---------------------------------------------------------------------------

/** Resolves/rejects with the inner promise, or rejects after `ms`. */
export function bounded(promise: Promise<unknown>, ms: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`cleanup exceeded ${ms}ms`)), ms);
        if (typeof timer.unref === 'function') timer.unref();
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

/** Minimal view of a signal source (`process`, or a stub in tests). */
export type SignalHost = {
    on: (event: string, listener: () => void) => unknown;
    removeListener?: (event: string, listener: () => void) => unknown;
};

export type SignalHandlerOptions = {
    /** Called once shutdown completed. Defaults to `process.exit`. */
    exit?: (code: number) => void;
    /** Exit code used after a signal-driven shutdown. */
    exitCode?: number;
};

/**
 * Wires SIGTERM/SIGINT to a graceful stop.
 *
 * PM2 stops and restarts processes with signals, so this path is what makes
 * "Stop" and "Restart" in the UI actually close the Deriv socket, release
 * subscriptions and persist a final `stopped` state - rather than killing the
 * process mid-contract and leaving a stale `running` stats file behind.
 *
 * A second signal while shutdown is in progress is ignored, so a double
 * `pm2 stop` cannot racing-restart anything.
 */
export function attachSignalHandlers(
    runtime: BotRuntime,
    host: SignalHost = process,
    options: SignalHandlerOptions = {}
): () => void {
    const exit = options.exit ?? ((code: number) => process.exit(code));
    const exitCode = options.exitCode ?? 0;
    let stopping = false;

    const onTerm = (): void => {
        if (stopping) return;
        stopping = true;
        void runtime
            .stop('signal:SIGTERM')
            .catch(() => undefined)
            .finally(() => exit(exitCode));
    };
    const onInt = (): void => {
        if (stopping) return;
        stopping = true;
        void runtime
            .stop('signal:SIGINT')
            .catch(() => undefined)
            .finally(() => exit(exitCode));
    };

    host.on('SIGTERM', onTerm);
    host.on('SIGINT', onInt);

    return () => {
        host.removeListener?.('SIGTERM', onTerm);
        host.removeListener?.('SIGINT', onInt);
    };
}

/**
 * Boots a bot from the environment.
 *
 * Returns the exit code the process should report. `authenticated` is the only
 * outcome that leaves the process running: the interpreter loop and the open
 * Deriv socket keep the event loop alive, and the SIGTERM handler exits.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
    const parsed = parseConfigFromEnv(env);
    if (!parsed.ok) {
        // eslint-disable-next-line no-console
        console.error(`[bot-runtime] configuration error: ${parsed.error}`);
        return 2;
    }

    const runtime = new BotRuntime(parsed.config);
    attachSignalHandlers(runtime);

    const state = await runtime.start();
    if (state === 'authenticated') return 0;

    // `expired`/`error`/`stopped` need user action or a redeploy. Exiting (rather
    // than idling) makes PM2 surface the failure honestly instead of showing a
    // healthy process that is doing nothing.
    return state === 'expired' ? 3 : 1;
}

/** True when this module is the process entry point (not an imported helper). */
export function isEntryModule(entry = process.argv[1]): boolean {
    if (!entry) return false;
    try {
        return pathToFileURL(entry).href === import.meta.url;
    } catch {
        return false;
    }
}
