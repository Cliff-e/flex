/**
 * Secret redaction for the headless VPS bot runtime.
 *
 * WHY THIS EXISTS
 * ---------------
 * The existing `trade_definition` code generator embeds the Deriv access token in
 * the generated source (`Bot.init('<token>', ...)`). That means the generated
 * source is secret material, and so are the raw access token, the OTP WS URL and
 * the OTP token itself.
 *
 * A VPS bot runs unattended for days and PM2 captures its stdout/stderr into
 * files. A single stray log line therefore persists a live credential to disk.
 * Rather than relying on every call site being careful, this module provides:
 *
 *   1. a registry of known secrets, and
 *   2. a console wrapper that scrubs those secrets (plus common credential
 *      shapes) out of anything written to stdout/stderr.
 *
 * This is DEFENCE IN DEPTH, not a licence to log credentials: the runtime still
 * never passes the generated source, an access token, an OTP URL or an OTP token
 * to any logger. The wrapper exists so that a mistake in a transitive
 * dependency (the bot-skeleton logs a lot) cannot leak a credential to disk.
 */

/** Replacement marker written wherever a secret was removed. */
export const REDACTED = '[REDACTED]';

/**
 * Secrets shorter than this are not registered: masking a 4-character string
 * would mangle unrelated output without protecting anything meaningful.
 * Deriv access tokens and OTP tokens are far longer than this.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * Credential shapes that must be scrubbed even when the value was never
 * registered - e.g. an OTP token embedded in a signed WS URL, or a token echoed
 * back inside an upstream error body.
 */
const SHAPE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    // `wss://.../?otp=<token>` - the signed OTP credential.
    [/\botp=([^&\s"'`]+)/gi, `otp=${REDACTED}`],
    // `Authorization: Bearer <token>` / `Bearer <token>`.
    [/\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/g, `Bearer ${REDACTED}`],
    // Deriv/Ory access tokens (`ory_at_…`) and generic `*_token=` params.
    [/\bory_[a-z]{2}_[A-Za-z0-9._~+/=-]{8,}/gi, REDACTED],
    [/\b((?:access|refresh|id)_?token=)([^&\s"'`]+)/gi, `$1${REDACTED}`],
];

/** Registers secrets and scrubs them from arbitrary text. */
export class SecretRegistry {
    private readonly _secrets = new Set<string>();

    /**
     * Registers a secret value. Non-strings and short strings are ignored, so
     * callers can register a whole credential object without filtering first.
     */
    register(value: unknown): void {
        if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
        this._secrets.add(value);
    }

    registerAll(values: Iterable<unknown>): void {
        for (const value of values) this.register(value);
    }

    /** Drops a secret again (used when a credential is rotated/replaced). */
    forget(value: unknown): void {
        if (typeof value === 'string') this._secrets.delete(value);
    }

    clear(): void {
        this._secrets.clear();
    }

    get size(): number {
        return this._secrets.size;
    }

    /** True when `value` is a registered secret. */
    isSecret(value: unknown): boolean {
        return typeof value === 'string' && this._secrets.has(value);
    }

    /**
     * Removes every registered secret and every known credential shape from
     * `text`. Longest secrets are replaced first so a token that contains
     * another token as a prefix cannot leave a partial value behind.
     */
    redact(text: string): string {
        let output = text;

        const ordered = [...this._secrets].sort((a, b) => b.length - a.length);
        for (const secret of ordered) {
            if (output.includes(secret)) output = output.split(secret).join(REDACTED);
        }

        for (const [pattern, replacement] of SHAPE_PATTERNS) {
            output = output.replace(pattern, replacement);
        }

        return output;
    }

    /**
     * Redacts every string inside an arbitrary value. Used for objects that are
     * about to be logged, so a nested credential cannot slip through.
     */
    redactDeep<T>(value: T, depth = 0): T {
        if (depth > 6) return value;
        if (typeof value === 'string') return this.redact(value) as unknown as T;
        if (value === null || typeof value !== 'object') return value;

        if (Array.isArray(value)) {
            return value.map(entry => this.redactDeep(entry, depth + 1)) as unknown as T;
        }
        if (value instanceof Date) return value;

        const output: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            output[key] = this.redactDeep(entry, depth + 1);
        }
        return output as unknown as T;
    }
}

/** Process-wide registry shared by the connection, runtime and stats modules. */
export const secrets = new SecretRegistry();

/**
 * Renders a credential for diagnostics without revealing it.
 *
 * `maskCredential('ory_at_abcdefghijklmnop')` -> `'ory_at_a…mnop'`
 * The result is always short and never enough to reconstruct the value, so it is
 * safe to include in logs and in API responses.
 */
export function maskCredential(value: string | null | undefined): string {
    if (!value) return '(none)';
    if (value.length <= 10) return '····';
    return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/**
 * Converts an arbitrary thrown value into a single redacted, length-bounded
 * line. Stack traces are deliberately excluded: a stack captured inside the
 * interpreter can contain a frame of generated source, and generated source
 * contains the access token.
 */
export function safeErrorText(error: unknown, maxLength = 300): string {
    let text: string;
    if (error instanceof Error) {
        text = `${error.name}: ${error.message}`;
    } else if (typeof error === 'string') {
        text = error;
    } else {
        try {
            text = JSON.stringify(error) ?? String(error);
        } catch {
            text = '(unserialisable error)';
        }
    }

    const redacted = secrets.redact(text).replace(/\s+/g, ' ').trim();
    return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
}

/** The subset of `console` this module wraps. */
export type ConsoleLike = {
    log: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
};

function scrubArgument(argument: unknown): unknown {
    if (typeof argument === 'string') return secrets.redact(argument);

    if (argument instanceof Error) {
        // Never hand a live Error to console: its stack can contain generated
        // source. A redacted name+message is all a log reader needs.
        return safeErrorText(argument);
    }

    if (argument === null || typeof argument !== 'object') return argument;

    // Structured data (blockly objects, maps, …): only attempt deep scrubbing
    // when the serialised form actually contains something we must protect -
    // otherwise pass the original through so the log stays readable.
    try {
        const json = JSON.stringify(argument);
        if (json === undefined) return argument;
        const scrubbed = secrets.redact(json);
        if (scrubbed === json) return argument;
        return scrubbed;
    } catch {
        return argument;
    }
}

/**
 * Wraps the console methods so every argument is scrubbed before it reaches the
 * real console (and therefore before PM2 writes it to disk).
 *
 * Returns an uninstall function, so tests can restore the original console.
 */
export function installConsoleRedaction(target: ConsoleLike = console): () => void {
    const originals: Partial<Record<keyof ConsoleLike, (...args: unknown[]) => void>> = {};

    const methods: ReadonlyArray<keyof ConsoleLike> = ['log', 'info', 'warn', 'error', 'debug'];

    for (const method of methods) {
        const original = target[method];
        if (typeof original !== 'function') continue;

        originals[method] = original.bind(target);
        target[method] = (...args: unknown[]) => {
            originals[method]?.(...args.map(scrubArgument));
        };
    }

    return () => {
        for (const method of methods) {
            const original = originals[method];
            if (original) target[method] = original;
        }
    };
}
