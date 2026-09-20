/**
 * PM2 control adapter.
 *
 * THREAT MODEL
 * ------------
 * Process control is the one place where user intent could turn into arbitrary
 * command execution, so this module is built so that it cannot:
 *
 *   1. `execFile` ONLY. There is no `exec`, no `spawn` with a shell, and
 *      `shell: false` is set explicitly. Nothing here ever concatenates a string
 *      into a command line.
 *   2. FIXED ARGUMENT ARRAYS. Every call site is a literal array whose elements
 *      are either a constant or a value derived from a validated bot id.
 *   3. SERVER-DERIVED NAMES. PM2 process names come from `pm2ProcessName(botId)`,
 *      which rejects anything that is not `bot-###`. `flex-api` is not reachable
 *      through this module: no function accepts a process name.
 *   4. ALLOWLISTED OPERATIONS. start / stop / restart / delete / describe / list.
 *      There is no "run this verb" function.
 *   5. PER-BOT APP CONFIG FILES. Starting a bot points PM2 at a generated
 *      `pm2.config.json` inside that bot's own directory, so the runtime entry,
 *      cwd, log paths and environment are all fixed at deploy time rather than
 *      passed as request arguments.
 *
 * No credential is ever placed in the PM2 config: `pm2 save` writes the process
 * environment into `~/.pm2/dump.pm2`, so a token in `env` would be persisted in
 * a second location. The runtime reads its own `credentials.json` instead.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { PM2_NAME_PATTERN, assertValidBotId, pm2ProcessName } from "./botPaths";

/** Arguments are fixed arrays; this is the only execution primitive used. */
type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { shell: boolean; timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export class Pm2Error extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, message: string, detail = "") {
    super(message);
    this.name = "Pm2Error";
    this.code = code;
    this.detail = detail;
  }
}

/** Where PM2 might live. All absolute; never resolved through PATH. */
const PM2_CANDIDATE_PATHS = [
  "/usr/local/bin/pm2",
  "/usr/bin/pm2",
  "/usr/local/lib/node_modules/pm2/bin/pm2",
  "/opt/nodejs/bin/pm2",
];

export type Pm2Invocation = { file: string; args: string[] };

/** Records every PM2 invocation this process made (diagnostics + tests). */
const invocations: Pm2Invocation[] = [];

export function recentPm2Invocations(): readonly Pm2Invocation[] {
  return invocations;
}

export function clearPm2Invocations(): void {
  invocations.length = 0;
}

/**
 * Absolute path to the PM2 executable.
 *
 * `PM2_BIN` may override it (used by the Phase 2 verification harness to point at
 * a stub binary). The value is always an absolute path and is never built from
 * user input.
 */
export function resolvePm2Bin(): string {
  const configured = process.env["PM2_BIN"];
  if (configured && configured.trim() !== "") return path.resolve(configured);

  for (const candidate of PM2_CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Pm2Error(
    "pm2_not_found",
    "PM2 executable not found. Set PM2_BIN to the absolute path of the pm2 executable.",
  );
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Resolves how to invoke the PM2 program.
 *
 * PM2 is itself a Node CLI, and plenty of installs expose it as a JS entry point
 * (`…/pm2/bin/pm2`, `pm2.js`) rather than a self-executing shim. When the
 * resolved path is a `.js`/`.mjs`/`.cjs` file it is run with the current Node
 * binary; otherwise it is executed directly. Either way the file and the
 * argument list stay separate - `shell: false` is never relaxed.
 */
function interpreterFor(file: string): { file: string; prefixArgs: string[] } {
  if (/\.(?:mjs|cjs|js)$/i.test(file)) return { file: process.execPath, prefixArgs: [file] };
  return { file, prefixArgs: [] };
}

/** Runs `pm2` with a fixed argument array. The only execution path in this file. */
async function runPm2(args: readonly string[], exec: ExecFileFn = defaultExecFile): Promise<string> {
  const resolved = resolvePm2Bin();
  // Every element must be a plain string; a non-string would be a programming
  // error, not user input, but failing loudly keeps the invariant obvious.
  const safeArgs = args.map((arg) => {
    if (typeof arg !== "string") throw new Pm2Error("invalid_argument", "PM2 arguments must be strings");
    return arg;
  });

  const { file, prefixArgs } = interpreterFor(resolved);
  const fullArgs = [...prefixArgs, ...safeArgs];

  invocations.push({ file, args: [...fullArgs] });

  try {
    const { stdout } = await exec(file, fullArgs, {
      shell: false,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Pm2Error("pm2_failed", `pm2 ${safeArgs[0] ?? ""} failed`, detail);
  }
}

const defaultExecFile: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr: String(stderr) }));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Live view of one PM2 process, as reported by `pm2 jlist`. */
export type Pm2ProcessInfo = {
  name: string;
  status: string;
  pid: number | null;
  restarts: number;
  uptimeMs: number | null;
  memoryBytes: number | null;
};

/** The exact shape this module reads out of `pm2 jlist`. */
type JlistEntry = {
  name?: unknown;
  pid?: unknown;
  pm2_env?: {
    status?: unknown;
    restart_time?: unknown;
    pm_uptime?: unknown;
    pm2_uptime?: unknown;
  };
  monit?: { memory?: unknown };
};

/** Parses `pm2 jlist` output. Exported so the mapping itself is testable. */
export function parseJlist(stdout: string): Pm2ProcessInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Pm2Error("pm2_unparsable", "pm2 jlist did not return JSON");
  }
  if (!Array.isArray(parsed)) throw new Pm2Error("pm2_unparsable", "pm2 jlist did not return an array");

  return (parsed as JlistEntry[])
    .filter((entry): entry is JlistEntry => entry !== null && typeof entry === "object")
    .map((entry) => {
      const name = typeof entry.name === "string" ? entry.name : "";
      const startedAt = entry.pm2_env?.pm_uptime;
      const uptimeMs =
        typeof startedAt === "number" && Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
      return {
        name,
        status: typeof entry.pm2_env?.status === "string" ? entry.pm2_env.status : "unknown",
        pid: typeof entry.pid === "number" ? entry.pid : null,
        restarts: typeof entry.pm2_env?.restart_time === "number" ? entry.pm2_env.restart_time : 0,
        uptimeMs,
        memoryBytes: typeof entry.monit?.memory === "number" ? entry.monit.memory : null,
      };
    });
}

/** All PM2 processes on the host. The API filters this down to `vps-bot-bot-###`. */
export async function listProcesses(exec?: ExecFileFn): Promise<Pm2ProcessInfo[]> {
  const stdout = await runPm2(["jlist"], exec);
  return parseJlist(stdout);
}

/** Live info for one bot's process, or null when PM2 does not know it. */
export async function describeBot(botId: unknown, exec?: ExecFileFn): Promise<Pm2ProcessInfo | null> {
  const name = pm2ProcessName(botId);
  const processes = await listProcesses(exec);
  return processes.find((process) => process.name === name) ?? null;
}

/** True when the process name is one this module is allowed to touch. */
export function assertManagedProcessName(name: unknown): string {
  if (typeof name !== "string" || !PM2_NAME_PATTERN.test(name)) {
    throw new Pm2Error("invalid_process_name", "Refusing to act on a process that is not a VPS bot process");
  }
  return name;
}

/**
 * Starts a bot from its generated config file.
 *
 * `--update-env` re-reads the environment from the config file, so a redeploy
 * that changed `BOT_*` values takes effect without deleting the process.
 */
export async function startBot(botId: unknown, configPath: string, exec?: ExecFileFn): Promise<void> {
  const name = assertManagedProcessName(pm2ProcessName(botId));
  const config = assertConfigInsideBotDir(botId, configPath);
  // A bot may already be known to PM2 (stopped, or errored): `restart` is the
  // idempotent operation. `start` on the config file creates it when new.
  const existing = await describeBot(botId, exec);
  if (existing) {
    await runPm2(["restart", name, "--update-env"], exec);
    return;
  }
  await runPm2(["start", config, "--update-env"], exec);
}

export async function stopBot(botId: unknown, exec?: ExecFileFn): Promise<void> {
  const name = assertManagedProcessName(pm2ProcessName(botId));
  await runPm2(["stop", name], exec);
}

export async function restartBot(botId: unknown, exec?: ExecFileFn): Promise<void> {
  const name = assertManagedProcessName(pm2ProcessName(botId));
  await runPm2(["restart", name, "--update-env"], exec);
}

/** Removes a bot from PM2 entirely. Only ever acts on `vps-bot-bot-###`. */
export async function deleteBot(botId: unknown, exec?: ExecFileFn): Promise<void> {
  const name = assertManagedProcessName(pm2ProcessName(botId));
  await runPm2(["delete", name], exec);
}

/**
 * Persists the current process list so `pm2 startup` can restore it after a
 * reboot.
 *
 * This is called ONLY from the explicit deploy/start path when
 * `FLEX_BOTS_PM2_SAVE=1`, because `pm2 save` snapshots every process - including
 * temporary or debugging ones. The Phase 4 runbook verifies the list before
 * enabling it.
 */
export async function saveDump(exec?: ExecFileFn): Promise<void> {
  await runPm2(["save"], exec);
}

/** The generated config must live inside its own bot directory. */
function assertConfigInsideBotDir(botId: unknown, configPath: string): string {
  const id = assertValidBotId(botId);
  const resolved = path.resolve(configPath);
  if (path.basename(resolved) !== "pm2.config.json" || !resolved.includes(`${path.sep}${id}${path.sep}`)) {
    throw new Pm2Error("invalid_config_path", "Refusing to start a process from a config outside its bot directory");
  }
  return resolved;
}

/** The PM2 app-config document for one bot. Unbundled so tests can assert it. */
export type Pm2AppConfig = {
  name: string;
  script: string;
  cwd: string;
  interpreter: string;
  node_args: string;
  autorestart: boolean;
  max_restarts: number;
  restart_delay: number;
  kill_timeout: number;
  merge_logs: boolean;
  out_file: string;
  error_file: string;
  env: Record<string, string>;
};

/**
 * Builds the PM2 app config for a bot.
 *
 * Every value is derived server-side from the bot id. Two deliberate choices:
 *
 *   - `env` contains ONLY `BOT_*` and `NODE_ENV`. No credential ever goes into a
 *     PM2 config, because `pm2 save` snapshots process environments into
 *     `~/.pm2/dump.pm2`; a token there would be a second, easily-forgotten copy
 *     of a live credential. The runtime reads `<botDir>/credentials.json`.
 *   - `restart_delay` and `max_restarts` are bounded so a bot whose strategy
 *     crashes on start cannot spin at 100% CPU and starve the other bots on a
 *     1 GB / 2 vCPU host.
 */
export function buildPm2AppConfig(options: {
  botId: string;
  botDir: string;
  runtimeEntry: string;
  logDir: string;
  instanceName?: string;
}): Pm2AppConfig {
  const name = assertManagedProcessName(options.instanceName ?? pm2ProcessName(options.botId));
  const id = assertValidBotId(options.botId);
  const botDirectory = path.resolve(options.botDir);
  if (path.basename(botDirectory) !== id) {
    throw new Pm2Error("invalid_bot_dir", "Bot directory must end with the bot id");
  }

  return {
    name,
    // The SHARED runtime bundle - never a per-bot copy of node_modules.
    script: path.resolve(options.runtimeEntry),
    cwd: botDirectory,
    interpreter: process.execPath,
    node_args: "--enable-source-maps",
    autorestart: true,
    max_restarts: 5,
    restart_delay: 5_000,
    kill_timeout: 10_000,
    merge_logs: true,
    out_file: path.join(path.resolve(options.logDir), "out.log"),
    error_file: path.join(path.resolve(options.logDir), "error.log"),
    env: {
      NODE_ENV: "production",
      BOT_ID: id,
      BOT_DIR: botDirectory,
    },
  };
}
