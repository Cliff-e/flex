/**
 * PHASE 1 GATE - the headless bot runtime is real, reusable and safe.
 *
 * Run: node dist-headless/verify-phase1.mjs
 *
 * What this harness proves, and how
 * ---------------------------------
 * It exercises the SAME modules the VPS runs, through the SAME code paths:
 *
 *   A  configuration/path validation     - bot id + directory derived and checked
 *   B  secret redaction                  - tokens never survive into log output
 *   C  statistics                        - only genuine settlements are counted
 *   D  runtime end-to-end                - real XML -> real generator -> real
 *                                          credential injection, with the Deriv
 *                                          transport replaced by a double
 *   E  authentication state machine      - authenticated / expired / error and
 *                                          the documented OTP-renewal mechanism
 *   F  SIGTERM/SIGINT handling           - graceful, idempotent shutdown
 *   G  a real child process              - reports a terminal state and a
 *                                          sanitised stats.json, honestly
 *
 * HONESTY NOTE: section D/E/F substitute a scripted Deriv API double for the
 * socket. That is a TEST DOUBLE for the transport, not simulated market data
 * presented as real: nothing here claims a live connection or a live trade. Live
 * authenticated verification happens on the VPS in Phase 4.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootHeadlessRuntime } from './blocklyHeadless';
import { REDACTED, installConsoleRedaction, maskCredential, safeErrorText, secrets, type ConsoleLike } from './redact';
import { StatsCollector, readStats, type BotState, type ContractStatusEvent } from './stats';
import type {
    AccountModeLike,
    ApiBaseLike,
    AuthSessionLike,
    AuthFailure,
    DerivConnection as DerivConnectionClass,
    DerivConnectionDeps,
    DerivCredentials,
    EventBusLike,
} from './derivConnection';
import type {
    BotRuntime as BotRuntimeClass,
    BotRuntimeDeps,
    InterpreterLike,
    ObserverLike,
    SignalHost,
} from './runtime';
import { installHeadlessShims } from './shim';

// ---------------------------------------------------------------------------
// Boot order
// ---------------------------------------------------------------------------
//
// The runtime graph (trade engine, api_base, @/components/shared) reads DOM
// globals such as `window.location` at MODULE SCOPE. The shims must therefore be
// installed before those modules are evaluated - which is why the two heavy
// modules below are loaded dynamically, exactly as the Phase 0 spike does.
installHeadlessShims();

const { DerivConnection, credentialFingerprint, loadCredentials } = await import('./derivConnection');
const { BOT_ID_PATTERN, BotRuntime, attachSignalHandlers, parseConfigFromEnv, readStrategyXml } = await import(
    './runtime'
);

// ---------------------------------------------------------------------------
// Tiny assertion harness (same style as the Phase 0 spike)
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function section(title: string): void {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${title} ===`);
}

function check(name: string, condition: boolean, detail = ''): void {
    if (condition) {
        passed += 1;
        // eslint-disable-next-line no-console
        console.log(`  PASS  ${name}`);
    } else {
        const line = `${name}${detail ? ` — ${detail}` : ''}`;
        failures.push(line);
        // eslint-disable-next-line no-console
        console.log(`  FAIL  ${line}`);
    }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');
const strategiesDir = path.join(projectDir, 'src', 'xml');
const workRoot = path.join(tmpdir(), 'flex-bots-phase1-verify');

function freshBotDir(botId: string): string {
    const dir = path.join(workRoot, botId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** A syntactically valid but deliberately useless credential - never usable. */
const BOGUS_ACCESS_TOKEN = 'ory_at_phase1bogustoken0000000000000000000000';
const REAL_ACCOUNT_ID = 'VRTC1234567';

// ---------------------------------------------------------------------------
// Test doubles for the collaborators (transport only - never trading logic)
// ---------------------------------------------------------------------------

class FakeAuthSession implements AuthSessionLike {
    setActiveAccountCalls: Array<{ loginid: string; token: string }> = [];
    invalidateOtpCacheCalls = 0;

    setActiveAccount(loginid: string, token: string): void {
        this.setActiveAccountCalls.push({ loginid, token });
    }
    invalidateOtpCache(): void {
        this.invalidateOtpCacheCalls += 1;
    }
    isAuthenticated(): boolean {
        return this.setActiveAccountCalls.length > 0;
    }
}

class FakeAccountMode implements AccountModeLike {
    enableCalls = 0;
    enableAccountMode(): void {
        this.enableCalls += 1;
    }
}

class FakeApiBase implements ApiBaseLike {
    initCalls = 0;
    terminateCalls = 0;
    is_authorized = false;
    account_id = '';
    token = '';
    account_info: { loginid?: string; currency?: string } | undefined;
    /** Scripted outcome of `init()` - resolves, or throws. */
    initImpl: () => Promise<void> = async () => undefined;

    async init(): Promise<void> {
        this.initCalls += 1;
        await this.initImpl();
    }
    terminate(): void {
        this.terminateCalls += 1;
    }
}

class FakeEventBus implements EventBusLike {
    private _handlers: Array<(payload: AuthFailure) => void> = [];

    on(_event: 'auth:failed', handler: (payload: AuthFailure) => void): () => void {
        this._handlers.push(handler);
        return () => {
            this._handlers = this._handlers.filter(entry => entry !== handler);
        };
    }
    emit(payload: AuthFailure): void {
        for (const handler of [...this._handlers]) handler(payload);
    }
    get handlerCount(): number {
        return this._handlers.length;
    }
}

class FakeObserver implements ObserverLike {
    private _handlers = new Map<string, Set<(payload: unknown) => void>>();

    register(event: string, action: (payload: unknown) => void): void {
        if (!this._handlers.has(event)) this._handlers.set(event, new Set());
        this._handlers.get(event)!.add(action);
    }
    unregister(event: string, action: (payload: unknown) => void): void {
        this._handlers.get(event)?.delete(action);
    }
    emit(event: string, payload?: unknown): void {
        for (const handler of [...(this._handlers.get(event) ?? [])]) handler(payload);
    }
    countFor(event: string): number {
        return this._handlers.get(event)?.size ?? 0;
    }
    get totalHandlers(): number {
        let total = 0;
        for (const set of this._handlers.values()) total += set.size;
        return total;
    }
}

/** Captures everything the runtime logs, after redaction has been applied. */
class CaptureConsole {
    lines: unknown[][] = [];
    log(...args: unknown[]): void {
        this.lines.push(args);
    }
    info(...args: unknown[]): void {
        this.lines.push(args);
    }
    warn(...args: unknown[]): void {
        this.lines.push(args);
    }
    error(...args: unknown[]): void {
        this.lines.push(args);
    }
    debug(...args: unknown[]): void {
        this.lines.push(args);
    }
    /** All captured output as one searchable string. */
    get text(): string {
        return this.lines.map(args => args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')).join('\n');
    }
}

class FakeSignalHost implements SignalHost {
    private _listeners = new Map<string, Set<() => void>>();

    on(event: string, listener: () => void): unknown {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event)!.add(listener);
        return this;
    }
    removeListener(event: string, listener: () => void): unknown {
        this._listeners.get(event)?.delete(listener);
        return this;
    }
    emit(event: string): void {
        for (const listener of [...(this._listeners.get(event) ?? [])]) listener();
    }
}

function fakeConnectionDeps(options: {
    apiBase?: FakeApiBase;
    authSession?: FakeAuthSession;
    accountMode?: FakeAccountMode;
    eventBus?: FakeEventBus;
} = {}): {
    deps: DerivConnectionDeps;
    apiBase: FakeApiBase;
    authSession: FakeAuthSession;
    accountMode: FakeAccountMode;
    eventBus: FakeEventBus;
} {
    const apiBase = options.apiBase ?? new FakeApiBase();
    const authSession = options.authSession ?? new FakeAuthSession();
    const accountMode = options.accountMode ?? new FakeAccountMode();
    const eventBus = options.eventBus ?? new FakeEventBus();
    return { deps: { apiBase, authSession, accountMode, eventBus }, apiBase, authSession, accountMode, eventBus };
}


// ---------------------------------------------------------------------------
// A. Configuration and path validation
// ---------------------------------------------------------------------------

section('A. Configuration and path validation');
{
    const ok = parseConfigFromEnv({ BOT_ID: 'bot-001', BOT_DIR: '/opt/flex-bots/bot-001' });
    check('valid env accepted', ok.ok === true, ok.ok ? '' : ok.error);
    if (ok.ok) {
        check('xml path derived from bot dir', ok.config.xmlPath === path.join(ok.config.botDir, 'bot.xml'));
        check('stats path derived from bot dir', ok.config.statsPath === path.join(ok.config.botDir, 'stats.json'));
        check(
            'credential file defaults inside the bot dir',
            ok.config.credentialFile === path.join(ok.config.botDir, 'credentials.json')
        );
    }

    check('missing BOT_ID rejected', parseConfigFromEnv({}).ok === false);
    check(
        'traversal BOT_ID rejected',
        parseConfigFromEnv({ BOT_ID: '../etc', BOT_DIR: '/opt/flex-bots/../etc' }).ok === false
    );
    check(
        'shell metacharacters in BOT_ID rejected',
        parseConfigFromEnv({ BOT_ID: 'bot-001; rm -rf /', BOT_DIR: '/opt/flex-bots/bot-001' }).ok === false
    );
    check('short BOT_ID rejected', parseConfigFromEnv({ BOT_ID: 'bot-1', BOT_DIR: '/opt/flex-bots/bot-1' }).ok === false);
    check(
        'BOT_DIR whose basename differs from BOT_ID rejected',
        parseConfigFromEnv({ BOT_ID: 'bot-001', BOT_DIR: '/opt/flex-bots/bot-002' }).ok === false
    );
    check(
        'BOT_DIR containing .. rejected',
        parseConfigFromEnv({ BOT_ID: 'bot-001', BOT_DIR: '/opt/../../root/bot-001' }).ok === false
    );
    check(
        'relative BOT_DIR rejected',
        parseConfigFromEnv({ BOT_ID: 'bot-001', BOT_DIR: 'flex-bots/bot-001' }).ok === false
    );
    check(
        'credential path outside BOT_DIR rejected',
        parseConfigFromEnv({
            BOT_ID: 'bot-001',
            BOT_DIR: '/opt/flex-bots/bot-001',
            BOT_CREDENTIAL_FILE: '/etc/shadow',
        }).ok === false
    );

    check('BOT_ID pattern is strict', BOT_ID_PATTERN.test('bot-001') && !BOT_ID_PATTERN.test('bot-0001'));

    const missingCreds = loadCredentials({ credentialFile: path.join(workRoot, 'does-not-exist.json') });
    check('missing credential file reports a reason', missingCreds.ok === false);
    check(
        'credential failure reason leaks no path-independent secret',
        missingCreds.ok === false && !missingCreds.reason.includes(BOGUS_ACCESS_TOKEN)
    );
}

// ---------------------------------------------------------------------------
// B. Secret redaction
// ---------------------------------------------------------------------------

section('B. Secret redaction');
{
    const registryToken = 'TOKEN_for_redaction_test_1234567890abcdef';
    secrets.register(registryToken);

    check('registered secret is replaced', !secrets.redact(`x=${registryToken}`).includes(registryToken));
    check('redaction marker is present', secrets.redact(registryToken).includes(REDACTED));
    check(
        'otp query parameter is scrubbed',
        secrets.redact('wss://api.derivws.com/ws?otp=abcdefghijklmnop').includes(`otp=${REDACTED}`)
    );
    check(
        'Bearer header is scrubbed',
        !secrets.redact('Authorization: Bearer abcdefghijklmnopqrst').includes('abcdefghijklmnopqrst')
    );
    check(
        'Ory token shape is scrubbed without being registered',
        !secrets.redact(`token=${BOGUS_ACCESS_TOKEN}`).includes('phase1bogustoken')
    );

    const masked = maskCredential('ory_at_abcdefghijklmnop');
    check('maskCredential reveals nothing usable', masked.length < 24 && !masked.includes('abcdefghijklmnop'));

    // A dedicated sink, so `check()` output stays visible on the terminal while
    // the wrapper is installed.
    const sink = new CaptureConsole();
    const restore = installConsoleRedaction(sink);
    sink.log('leaking', registryToken, { nested: registryToken });
    sink.error(new Error(`failed with ${registryToken}`));
    restore();

    check('console.log output is scrubbed', !sink.text.includes(registryToken));
    check('nested object value is scrubbed', !sink.text.includes(registryToken));
    check('Error message is scrubbed', !sink.text.includes(registryToken));
    check('scrubbing actually happened', sink.text.includes(REDACTED));

    sink.lines = [];
    sink.log(registryToken);
    check('console redaction is fully uninstalled', sink.text.includes(registryToken));

    const errorText = safeErrorText(new Error(`boom ${registryToken}`));
    check('safeErrorText removes the secret', !errorText.includes(registryToken));
    check('safeErrorText omits stack frames', !errorText.includes('    at '));
}


// ---------------------------------------------------------------------------
// C. Statistics
// ---------------------------------------------------------------------------

section('C. Statistics');
{
    const dir = path.join(workRoot, 'stats-check');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'stats.json');
    rmSync(file, { force: true });

    let clock = 1_700_000_000_000;
    const stats = new StatsCollector({ botId: 'bot-001', filePath: file, now: () => clock });

    stats.markStarted();
    check('initial status is starting', stats.status === 'starting');
    check('startedAt is recorded', stats.snapshot().startedAt !== null);

    check(
        'purchase_sent is NOT a trade',
        stats.recordContractEvent({ id: 'contract.purchase_sent', data: 1 }) === false
    );
    check(
        'purchase_received is NOT a trade',
        stats.recordContractEvent({ id: 'contract.purchase_received', data: 2 }) === false
    );
    check(
        'open-contract update is NOT a trade',
        stats.recordContractEvent({ id: 'contract.open', contract: { contract_id: 1, profit: 99 } }) === false
    );
    check(
        'settlement without a numeric profit is ignored',
        stats.recordContractEvent({ id: 'contract.sold', contract: { contract_id: 2 } }) === false
    );
    check('no trades counted yet', stats.snapshot().trades === 0);

    const winEvent: ContractStatusEvent = {
        id: 'contract.sold',
        contract: { contract_id: 11, profit: 1.25, currency: 'USD' },
    };
    check('genuine settlement is counted', stats.recordContractEvent(winEvent) === true);
    check('duplicate contract_id is not double counted', stats.recordContractEvent(winEvent) === false);
    check('trades = 1', stats.snapshot().trades === 1);
    check('wins = 1', stats.snapshot().wins === 1);
    check('profit = 1.25', stats.snapshot().profit === 1.25);
    check('currency captured from the settlement', stats.snapshot().currency === 'USD');
    check('lastTradeAt set', stats.snapshot().lastTradeAt !== null);

    check(
        'losing settlement counted',
        stats.recordContractEvent({ id: 'contract.sold', contract: { contract_id: 12, profit: -0.5 } }) === true
    );
    check('trades = 2', stats.snapshot().trades === 2);
    check('losses = 1', stats.snapshot().losses === 1);
    check('profit = 0.75', Math.abs(stats.snapshot().profit - 0.75) < 1e-9);

    clock += 60_000;
    check('uptimeSeconds derived from the clock', stats.snapshot().uptimeSeconds === 60);

    stats.recordTrade({ profit: 0 });
    check('zero-profit settlement is neither win nor loss', stats.snapshot().wins === 1 && stats.snapshot().losses === 1);
    check('scratch settlement still counts as a trade', stats.snapshot().trades === 3);

    stats.setStatus('authenticated');
    check('authenticated recorded', stats.snapshot().status === 'authenticated');
    stats.setStatus('expired', { error: `refused ${BOGUS_ACCESS_TOKEN}` });
    check('expired recorded', stats.snapshot().status === 'expired');
    check('error text was redacted before storage', !(stats.snapshot().error ?? '').includes(BOGUS_ACCESS_TOKEN));

    stats.flush();
    const onDisk = readStats(file);
    check('stats.json is readable JSON', onDisk !== null && onDisk.botId === 'bot-001');
    check('stats.json persists the status', onDisk?.status === 'expired');
    check('stats.json persists trades/profit', onDisk?.trades === 3 && Math.abs((onDisk?.profit ?? 0) - 0.75) < 1e-9);

    const raw = readFileSync(file, 'utf8');
    check('stats.json contains no access token', !raw.includes(BOGUS_ACCESS_TOKEN));
    check('stats.json contains no registered secret', !raw.includes('TOKEN_for_redaction_test_1234567890abcdef'));
    check('stats.json contains a redacted error only', raw.includes(REDACTED));

    stats.dispose();
    check('dispose leaves a valid file behind', readStats(file) !== null);
}


// ---------------------------------------------------------------------------
// D. Runtime end-to-end
// ---------------------------------------------------------------------------

/** Shared across D and F so one runtime instance covers start AND shutdown. */
let sharedRuntime: BotRuntimeClass | null = null;
let sharedObserver: FakeObserver | null = null;
let sharedApiBase: FakeApiBase | null = null;
let sharedAuthSession: FakeAuthSession | null = null;
let sharedAccountMode: FakeAccountMode | null = null;
let sharedConnection: DerivConnectionClass | null = null;
let sharedBotDir = '';
let sharedInterpreterStopCalls = 0;
let sharedGeneratedCode = '';
let sharedConsoleCapture = new CaptureConsole();

/**
 * Typed snapshot of the shared values.
 *
 * A plain reference would be narrowed to `null` by control-flow analysis before
 * the section that assigns it, so the values are read through a function whose
 * body sees their declared (not narrowed) types.
 */
function getShared(): {
    runtime: BotRuntimeClass | null;
    observer: FakeObserver | null;
    apiBase: FakeApiBase | null;
    authSession: FakeAuthSession | null;
    accountMode: FakeAccountMode | null;
    connection: DerivConnectionClass | null;
    botDir: string;
} {
    return {
        runtime: sharedRuntime,
        observer: sharedObserver,
        apiBase: sharedApiBase,
        authSession: sharedAuthSession,
        accountMode: sharedAccountMode,
        connection: sharedConnection,
        botDir: sharedBotDir,
    };
}

section('D. Runtime end-to-end (real XML -> real generator -> credential injection)');
{
    const botId = 'bot-001';
    sharedBotDir = freshBotDir(botId);

    // The real strategy the Bot Builder ships.
    const xml = readFileSync(path.join(strategiesDir, 'martingale.xml'), 'utf8');
    writeFileSync(path.join(sharedBotDir, 'bot.xml'), xml, 'utf8');
    // A syntactically valid credential - real format, deliberately useless.
    writeFileSync(
        path.join(sharedBotDir, 'credentials.json'),
        JSON.stringify({ account_id: REAL_ACCOUNT_ID, access_token: BOGUS_ACCESS_TOKEN, currency: 'USD' }),
        { encoding: 'utf8', mode: 0o600 }
    );

    const parsed = parseConfigFromEnv({ BOT_ID: botId, BOT_DIR: sharedBotDir, BOT_CONNECT_TIMEOUT_MS: '5000' });
    check('runtime config accepted', parsed.ok === true, parsed.ok ? '' : parsed.error);

    const readBack = readStrategyXml(path.join(sharedBotDir, 'bot.xml'));
    check('strategy file readable and non-empty', readBack.ok === true);

    if (parsed.ok) {
        const config = parsed.config;
        const fakes = fakeConnectionDeps();
        sharedApiBase = fakes.apiBase;
        sharedAuthSession = fakes.authSession;
        sharedAccountMode = fakes.accountMode;
        // Scripted: Deriv accepts the credential and authorizes the socket.
        fakes.apiBase.is_authorized = true;

        sharedObserver = new FakeObserver();

        const runtimeDeps: BotRuntimeDeps = {
            // The REAL headless boot from Phase 0 - no stubbing of the generator.
            boot: bootHeadlessRuntime,
            // Only the interpreter is doubled, so it can report what it was given.
            createInterpreter: () => {
                const fake: InterpreterLike = {
                    run: (code: string) => {
                        sharedGeneratedCode = code;
                        // A running strategy: never resolves during the test.
                        return new Promise<unknown>(() => undefined);
                    },
                    stop: () => {
                        sharedInterpreterStopCalls += 1;
                    },
                    terminateSession: async () => undefined,
                };
                return fake;
            },
            createConnection: (credentials: DerivCredentials) => {
                const connection = new DerivConnection(credentials, fakes.deps);
                sharedConnection = connection;
                return connection;
            },
            // The REAL loader, reading the REAL credential file.
            loadCredentials,
            observer: sharedObserver,
            now: () => Date.now(),
        };


        sharedConsoleCapture = new CaptureConsole();
        const consoleHost = globalThis as unknown as { console: ConsoleLike };
        const previousConsole = consoleHost.console;
        consoleHost.console = sharedConsoleCapture;

        const runtime = new BotRuntime(config, runtimeDeps);
        sharedRuntime = runtime;

        let state: BotState = 'error';
        try {
            state = await runtime.start();
        } catch (error) {
            check('runtime.start() must not throw', false, safeErrorText(error));
        } finally {
            consoleHost.console = previousConsole;
        }

        const observer = sharedObserver as FakeObserver;

        check('runtime reaches authenticated', state === 'authenticated', state);
        check('existing startup path reused (api_base.init called once)', fakes.apiBase.initCalls === 1);
        check(
            'credentials published through AuthSessionManager',
            fakes.authSession.setActiveAccountCalls.length === 1 &&
                fakes.authSession.setActiveAccountCalls[0].loginid === REAL_ACCOUNT_ID
        );
        check('account mode enabled (OTP WebSocket URL path)', fakes.accountMode.enableCalls === 1);
        check('strategy executed through the existing interpreter', sharedGeneratedCode.length > 200);
        // Credential injection point: the generator embeds client.getToken(loginid).
        check(
            'CREDENTIAL REACHED THE INJECTION POINT (Bot.init token)',
            sharedGeneratedCode.includes(BOGUS_ACCESS_TOKEN)
        );
        // The same extraction the Phase 0 gate uses: dropdown field values must
        // survive XML -> workspace -> generated code.
        const symbolMatch = /symbol\s*:\s*'([^']*)'/.exec(sharedGeneratedCode);
        check(
            'strategy field values survived XML -> generated code',
            symbolMatch?.[1] === 'WLDAUD',
            `symbol=${String(symbolMatch?.[1])}`
        );
        check('statistics bound to contract.status', observer.countFor('contract.status') === 1);
        check('stats status is authenticated', runtime.stats.snapshot().status === 'authenticated');

        // Genuine settlement event, shaped exactly as the trade engine emits it.
        observer.emit('contract.status', {
            id: 'contract.sold',
            contract: { contract_id: 424242, profit: 2.5, currency: 'USD' },
        });
        check(
            'observed settlement advances stats',
            runtime.stats.snapshot().trades === 1 && runtime.stats.snapshot().profit === 2.5
        );
        observer.emit('contract.status', { id: 'contract.purchase_sent', data: 1 });
        check('monitoring event does not change the trade count', runtime.stats.snapshot().trades === 1);

        runtime.stats.flush();
        const statsRaw = readFileSync(path.join(sharedBotDir, 'stats.json'), 'utf8');
        check('runtime stats.json carries no credential', !statsRaw.includes(BOGUS_ACCESS_TOKEN));
        check('runtime stats.json records the settlement', JSON.parse(statsRaw).trades === 1);

        const windowStart = Math.max(0, Math.floor(sharedGeneratedCode.length / 2) - 40);
        const codeFingerprint = sharedGeneratedCode.slice(windowStart, windowStart + 80);
        const captured = sharedConsoleCapture.text;
        check('GENERATED SOURCE WAS NEVER LOGGED', codeFingerprint.length > 0 && !captured.includes(codeFingerprint));
        check('ACCESS TOKEN WAS NEVER LOGGED', !captured.includes(BOGUS_ACCESS_TOKEN));
        check('token fragment never appears in logs', !captured.includes('phase1bogustoken'));
        check('runtime logged its own startup line', captured.includes('bot-001 starting'));
    }
}


// ---------------------------------------------------------------------------
// E. Authentication state machine and renewal
// ---------------------------------------------------------------------------

section('E. Authentication state machine and renewal');
{
    const creds = (overrides: Partial<DerivCredentials> = {}): DerivCredentials => ({
        accountId: REAL_ACCOUNT_ID,
        accessToken: BOGUS_ACCESS_TOKEN,
        appId: '33gBzpTA0Py8ehX45PBxR',
        currency: 'USD',
        source: 'file',
        ...overrides,
    });

    {
        const fakes = fakeConnectionDeps();
        fakes.apiBase.is_authorized = true;
        const connection = new DerivConnection(creds(), fakes.deps);
        const state = await connection.connect({ timeoutMs: 1_000 });
        check('authorized socket -> authenticated', state === 'authenticated', state);
        check('connect() drove api_base.init()', fakes.apiBase.initCalls === 1);
        check('credentials injected before init', fakes.authSession.setActiveAccountCalls.length === 1);
        check('account mode enabled before init', fakes.accountMode.enableCalls === 1);
        check('auth:failed listener attached', fakes.eventBus.handlerCount === 1);
        check('isAuthenticated reflects the state', connection.isAuthenticated === true);
    }

    {
        const fakes = fakeConnectionDeps();
        fakes.apiBase.initImpl = async () => {
            fakes.eventBus.emit({ code: 'InvalidToken', message: 'invalid token supplied' });
        };
        const connection = new DerivConnection(creds(), fakes.deps);
        const state = await connection.connect({ timeoutMs: 1_000 });
        check('Deriv refusing the token -> expired', state === 'expired', state);
        check(
            'failure detail carries no credential',
            !(connection.lastError ?? '').includes(BOGUS_ACCESS_TOKEN)
        );
    }

    {
        const fakes = fakeConnectionDeps();
        fakes.apiBase.initImpl = async () => {
            fakes.eventBus.emit({ code: 'SomethingUnexpected', message: 'unexpected server fault' });
        };
        const connection = new DerivConnection(creds(), fakes.deps);
        check('unexpected auth error code -> error', (await connection.connect({ timeoutMs: 1_000 })) === 'error');
    }

    {
        const fakes = fakeConnectionDeps();
        fakes.apiBase.initImpl = async () => {
            throw new Error('OTP request failed: 401 Unauthorized');
        };
        const connection = new DerivConnection(creds(), fakes.deps);
        check('OTP refusal (401) -> expired', (await connection.connect({ timeoutMs: 1_000 })) === 'expired');
    }

    {
        const fakes = fakeConnectionDeps();
        fakes.apiBase.initImpl = async () => {
            throw new Error('socket transport exploded');
        };
        const connection = new DerivConnection(creds(), fakes.deps);
        check('transport fault -> error', (await connection.connect({ timeoutMs: 1_000 })) === 'error');
    }

    {
        const fakes = fakeConnectionDeps();
        const connection = new DerivConnection(creds(), fakes.deps);
        check(
            'no authorization and no error -> expired',
            (await connection.connect({ timeoutMs: 1_000 })) === 'expired'
        );
    }

    {
        const fakes = fakeConnectionDeps();
        fakes.apiBase.initImpl = async () => {
            fakes.eventBus.emit({ code: 'InvalidToken' });
        };
        const connection = new DerivConnection(creds(), fakes.deps);
        check('first attempt expires', (await connection.connect({ timeoutMs: 1_000 })) === 'expired');

        const rotated = creds({ accessToken: 'ory_at_rotatedtoken0000000000000000000000000' });
        check('rotated credential is detected', connection.updateCredentials(rotated) === true);
        check('identical credential is not a rotation', connection.updateCredentials(rotated) === false);
        check(
            'fingerprints differ without exposing the token',
            credentialFingerprint(creds()) !== credentialFingerprint(rotated) &&
                !credentialFingerprint(rotated).includes('rotatedtoken')
        );

        // Deriv now accepts the rotated token.
        fakes.apiBase.initImpl = async () => {
            fakes.apiBase.is_authorized = true;
        };
        const renewed = await connection.refreshAuthentication({ timeoutMs: 1_000 });
        check('renewal re-mints the OTP credential', fakes.authSession.invalidateOtpCacheCalls >= 1);
        check('renewal drops the dead socket', fakes.apiBase.terminateCalls >= 1);
        check('renewal reaches authenticated', renewed === 'authenticated', renewed);
    }

    {
        const fakes = fakeConnectionDeps();
        fakes.apiBase.is_authorized = true;
        const connection = new DerivConnection(creds(), fakes.deps);
        await connection.connect({ timeoutMs: 1_000 });
        await connection.close();
        check('close() -> stopped', connection.state === 'stopped');
        check('close() tears the socket down', fakes.apiBase.terminateCalls === 1);
        check('close() detaches listeners', fakes.eventBus.handlerCount === 0);
        check('closed connection refuses to reconnect', (await connection.connect({ timeoutMs: 1_000 })) === 'stopped');
        await connection.close();
        check('close() is idempotent', fakes.apiBase.terminateCalls === 1);
    }
}


// ---------------------------------------------------------------------------
// F. SIGTERM / SIGINT handling (in-process, real handler wiring)
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await delay(25);
    }
    return predicate();
}

section('F. SIGTERM / SIGINT handling');
{
    const shared = getShared();
    const runtime = shared.runtime;
    const observer = shared.observer;
    const apiBase = shared.apiBase;

    if (!runtime || !observer || !apiBase) {
        check('a running runtime exists for the signal test', false, 'section D produced no runtime');
    } else {
        const host = new FakeSignalHost();
        const exitCodes: number[] = [];
        attachSignalHandlers(runtime, host, { exit: (code: number) => exitCodes.push(code) });

        host.emit('SIGTERM');
        const stopped = await waitFor(() => runtime.state === 'stopped', 8_000);

        check('SIGTERM stops the runtime', stopped, runtime.state);
        check('SIGTERM exits with code 0', exitCodes.length === 1 && exitCodes[0] === 0, JSON.stringify(exitCodes));
        check(
            'strategy execution was stopped',
            sharedInterpreterStopCalls === 1,
            String(sharedInterpreterStopCalls)
        );
        check('Deriv connection was closed', apiBase.terminateCalls >= 1);
        check('observer handlers were removed', observer.totalHandlers === 0, String(observer.totalHandlers));

        const finalStats = readStats(path.join(shared.botDir, 'stats.json'));
        check('stats.json records the final stopped state', finalStats?.status === 'stopped', String(finalStats?.status));

        // A second signal must not re-enter shutdown or double-exit.
        host.emit('SIGINT');
        host.emit('SIGTERM');
        await delay(60);
        check('repeated signals are ignored', exitCodes.length === 1, JSON.stringify(exitCodes));

        runtime.stats.flush();
        const raw = readFileSync(path.join(shared.botDir, 'stats.json'), 'utf8');
        const statsJson = JSON.parse(raw) as { trades: number; status: string };
        check('final stats.json carries no credential', !raw.includes(BOGUS_ACCESS_TOKEN));
        check('final stats.json keeps the settled trade', statsJson.trades === 1);
        check('final stats.json keeps the settled status', statsJson.status === 'stopped');
        check('credentials were published exactly once', shared.authSession?.setActiveAccountCalls.length === 1);
        check('account mode was enabled', shared.accountMode?.enableCalls === 1);
        check('Deriv connection reports stopped', shared.connection?.state === 'stopped', String(shared.connection?.state));
    }
}


// ---------------------------------------------------------------------------
// G. Real bot-runtime process
// ---------------------------------------------------------------------------

type ChildResult = { code: number | null; output: string };

function runChild(
    entry: string,
    env: Record<string, string>,
    timeoutMs = 25_000,
    preloadUrl?: string
): Promise<ChildResult> {
    return new Promise(resolve => {
        const args = preloadUrl ? ['--import', preloadUrl, entry] : [entry];
        const child = spawn(process.execPath, args, {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        child.stdout?.on('data', chunk => {
            output += String(chunk);
        });
        child.stderr?.on('data', chunk => {
            output += String(chunk);
        });

        const killTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.on('exit', code => {
            clearTimeout(killTimer);
            resolve({ code, output });
        });
    });
}

section('G. Real bot-runtime process');
{
    const runtimeBundle = path.join(here, 'bot-runtime.mjs');
    const bundleExists = existsSync(runtimeBundle);
    check('bot-runtime bundle exists (run build:bot-runtime first)', bundleExists, runtimeBundle);

    if (bundleExists) {
        const strategyXml = readFileSync(path.join(strategiesDir, 'martingale.xml'), 'utf8');

        // --- G1: no credential at all -> honest terminal state ----------------
        const g1BotId = 'bot-901';
        const g1Dir = freshBotDir(g1BotId);
        writeFileSync(path.join(g1Dir, 'bot.xml'), strategyXml, 'utf8');

        const g1 = await runChild(runtimeBundle, {
            BOT_ID: g1BotId,
            BOT_DIR: g1Dir,
            BOT_CONNECT_TIMEOUT_MS: '5000',
        });

        check('child without credentials exits with the documented code 3', g1.code === 3, String(g1.code));
        check('child announces the starting state', g1.output.includes(`${g1BotId} starting`));
        check('child reports expiry instead of success', g1.output.includes('expired'));
        check('child never claims an authenticated connection', !g1.output.includes('deriv connection authenticated'));

        const g1Stats = readStats(path.join(g1Dir, 'stats.json'));
        check('child wrote stats.json', g1Stats !== null);
        check('child stats.json status is expired', g1Stats?.status === 'expired', String(g1Stats?.status));
        check('child stats.json contains no fabricated trade', g1Stats?.trades === 0 && g1Stats?.profit === 0);

        // --- G2: SIGTERM through Node's real signal dispatch ------------------
        const g2BotId = 'bot-902';
        const g2Dir = freshBotDir(g2BotId);
        writeFileSync(path.join(g2Dir, 'bot.xml'), strategyXml, 'utf8');
        writeFileSync(
            path.join(g2Dir, 'credentials.json'),
            JSON.stringify({ account_id: REAL_ACCOUNT_ID, access_token: BOGUS_ACCESS_TOKEN, currency: 'USD' }),
            { encoding: 'utf8', mode: 0o600 }
        );

        // The preload module delivers a REAL `SIGTERM` through Node's signal
        // dispatch, so the production handler - not a test hook - performs the
        // shutdown. `--import` runs before the entry point, which keeps the bot
        // bundle itself free of any test-specific code. (OS-level delivery is
        // re-verified on the Linux VPS in Phase 4.)
        const preload = path.join(workRoot, 'signal-preload.mjs');
        writeFileSync(
            preload,
            ['// Generated by verifyPhase1 - delivers a real SIGTERM event.', "setTimeout(() => process.emit('SIGTERM'), 900);", ''].join(
                '\n'
            ),
            'utf8'
        );

        const g2 = await runChild(
            runtimeBundle,
            {
                BOT_ID: g2BotId,
                BOT_DIR: g2Dir,
                BOT_CONNECT_TIMEOUT_MS: '5000',
            },
            25_000,
            pathToFileURL(preload).href
        );

        check('SIGTERM produces a clean exit code 0', g2.code === 0, String(g2.code));
        check('child logged the signal-driven stop', g2.output.includes('stopping | reason=signal:SIGTERM'));
        check('child logged completion of shutdown', g2.output.includes(`${g2BotId} stopped`));

        const g2Stats = readStats(path.join(g2Dir, 'stats.json'));
        check('child persisted the stopped state', g2Stats?.status === 'stopped', String(g2Stats?.status));
        check('CHILD LOG CONTAINS NO ACCESS TOKEN', !g2.output.includes(BOGUS_ACCESS_TOKEN));
        check('CHILD LOG CONTAINS NO TOKEN FRAGMENT', !g2.output.includes('phase1bogustoken'));
    }
}


// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

rmSync(workRoot, { recursive: true, force: true });

// eslint-disable-next-line no-console
console.log(`\n[phase1] checks passed : ${passed}`);
// eslint-disable-next-line no-console
console.log(`[phase1] checks failed : ${failures.length}`);

if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.log('[phase1] failures:');
    for (const failure of failures) {
        // eslint-disable-next-line no-console
        console.log(`  - ${failure}`);
    }
    process.exitCode = 1;
} else {
    // eslint-disable-next-line no-console
    console.log('[phase1] GATE RESULT: PASS');
}
