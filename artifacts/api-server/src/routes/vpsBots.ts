/**
 * VPS bot management API.
 *
 * WHAT THIS OWNS
 * --------------
 *   upload   - validate a strategy and allocate a server-generated bot id
 *   deploy   - prepare the bot's isolated directory, PM2 config and credentials
 *   control  - start / stop / restart / delete that bot's PM2 process
 *   observe  - live process state (PM2) and live statistics (stats.json)
 *
 * WHAT THIS DELIBERATELY DOES NOT OWN
 * -----------------------------------
 *   - the trading runtime (it lives in the shared headless bundle the bot
 *     processes execute),
 *   - process state (PM2 is authoritative - this module reads it, never caches
 *     it, so the two can never disagree),
 *   - credentials at rest beyond writing the bot's own `credentials.json`.
 *
 * EVERY response body is assembled field-by-field from an explicit whitelist.
 * Nothing is ever spread from a file or a PM2 payload into a response, so a
 * credential cannot reach the client even if one were somehow written to disk.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import express, { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import { logger } from "../lib/logger";
import * as pm2 from "../lib/pm2Control";
import {
  BotPathError,
  assertBotCapacity,
  assertValidBotId,
  botCredentialPath,
  botDir,
  botDirExists,
  ensureBotDir,
  botLogDir,
  botLogPath,
  botPm2ConfigPath,
  botStatsPath,
  botXmlPath,
  listBotIds,
  maxBots,
  pm2ProcessName,
  runtimeEntryPath,
} from "../lib/botPaths";
import {
  createBotRecord,
  getBotRecord,
  isDeploymentStatus,
  listBotRecords,
  removeBotRecord,
  upsertBotRecord,
  type BotDeploymentStatus,
} from "../lib/botRegistry";
import { getDerivAuth, requireDerivAuth } from "../lib/requireDerivAuth";
import { MAX_XML_BYTES, validateBotName, validateStrategyXml } from "../lib/validateBotXml";
import { asHandler, vpsBotControlRateLimiter, vpsBotUploadRateLimiter } from "../middlewares/rateLimit";

/** Whitelisted view of the runtime's `stats.json`. */
export type PublicBotStats = {
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

/** Whitelisted view of a bot's PM2 process. */
export type PublicBotProcess = {
  managed: boolean;
  status: string;
  pid: number | null;
  restarts: number;
  uptimeMs: number | null;
  memoryBytes: number | null;
};

/** The complete bot representation returned by the API. */
export type PublicBot = {
  botId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deployment: { status: BotDeploymentStatus; deployedAt: string | null };
  process: PublicBotProcess;
  stats: PublicBotStats | null;
  accountId: string | null;
};

export type VpsBotsPm2 = {
  listProcesses: typeof pm2.listProcesses;
  describeBot: typeof pm2.describeBot;
  startBot: typeof pm2.startBot;
  stopBot: typeof pm2.stopBot;
  restartBot: typeof pm2.restartBot;
  deleteBot: typeof pm2.deleteBot;
  saveDump: typeof pm2.saveDump;
  buildPm2AppConfig: typeof pm2.buildPm2AppConfig;
};

export type VpsBotsDeps = {
  /** Authentication middleware; injectable so the gate can exercise all branches. */
  auth: RequestHandler;
  uploadLimiter: RequestHandler;
  controlLimiter: RequestHandler;
  /** PM2 adapter; injectable so the gate can run in a safe test mode. */
  pm2: VpsBotsPm2;
  maxLogLines: number;
  maxLogBytes: number;
  /** Persist the PM2 process list after start (reboot recovery). Off by default. */
  pm2Save: boolean;
};

const DEFAULT_MAX_LOG_LINES = 200;
const DEFAULT_MAX_LOG_BYTES = 64 * 1024;

function defaultDeps(): VpsBotsDeps {
  return {
    auth: requireDerivAuth,
    uploadLimiter: asHandler(vpsBotUploadRateLimiter),
    controlLimiter: asHandler(vpsBotControlRateLimiter),
    pm2,
    maxLogLines: DEFAULT_MAX_LOG_LINES,
    maxLogBytes: DEFAULT_MAX_LOG_BYTES,
    pm2Save: process.env["FLEX_BOTS_PM2_SAVE"] === "1",
  };
}

// ---------------------------------------------------------------------------
// Response shaping (explicit whitelists only)
// ---------------------------------------------------------------------------

function asStringOrNull(value: unknown, maxLength = 300): string | null {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Reads `stats.json` into the public shape.
 *
 * Field by field, on purpose: an unknown key in the file (a credential someone
 * accidentally wrote, a future field) can never be forwarded to a client.
 */
export function readPublicStats(botId: string): PublicBotStats | null {
  const file = botStatsPath(botId);
  if (!existsSync(file)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;

  const record = raw as Record<string, unknown>;
  const currency = asStringOrNull(record["currency"], 10);

  return {
    status: asStringOrNull(record["status"], 24) ?? "unknown",
    startedAt: asStringOrNull(record["startedAt"], 40),
    lastActivityAt: asStringOrNull(record["lastActivityAt"], 40),
    lastTradeAt: asStringOrNull(record["lastTradeAt"], 40),
    trades: asCount(record["trades"]),
    wins: asCount(record["wins"]),
    losses: asCount(record["losses"]),
    profit: asNumberOrNull(record["profit"]) ?? 0,
    currency,
    uptimeSeconds: asCount(record["uptimeSeconds"]),
    error: asStringOrNull(record["error"], 300),
  };
}

function notManaged(): PublicBotProcess {
  return { managed: false, status: "offline", pid: null, restarts: 0, uptimeMs: null, memoryBytes: null };
}

/** Builds the public representation of one bot from PM2 + the registry + stats. */
export async function buildPublicBot(
  botId: string,
  deps: VpsBotsDeps,
): Promise<PublicBot | null> {
  const record = getBotRecord(botId);

  let live: pm2.Pm2ProcessInfo | null = null;
  try {
    live = await deps.pm2.describeBot(botId, undefined);
  } catch (error) {
    // PM2 being unreachable must not hide the bot from the UI: report it as
    // offline rather than failing the whole listing.
    logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "[vps-bots] pm2 describe failed");
  }

  // A directory without a registry record is still a bot on disk; synthesise the
  // metadata so the UI never shows a phantom or hides a real directory.
  if (!record && !botDirExists(botId)) return null;

  const deploymentStatus: BotDeploymentStatus = isDeploymentStatus(record?.deploymentStatus)
    ? record.deploymentStatus
    : "uploaded";

  return {
    botId,
    name: record?.name ?? botId,
    createdAt: record?.createdAt ?? new Date(0).toISOString(),
    updatedAt: record?.updatedAt ?? new Date(0).toISOString(),
    deployment: { status: deploymentStatus, deployedAt: record?.deployedAt ?? null },
    process: live
      ? {
          managed: true,
          status: live.status,
          pid: live.pid,
          restarts: live.restarts,
          uptimeMs: live.uptimeMs,
          memoryBytes: live.memoryBytes,
        }
      : notManaged(),

    stats: readPublicStats(botId),
    accountId: record?.accountId ?? null,
  };
}


// ---------------------------------------------------------------------------
// Log handling
// ---------------------------------------------------------------------------

/**
 * Credential shapes scrubbed from any log text before it is returned.
 *
 * The runtime is already careful (Phase 1 verifies it never logs a token or the
 * generated source), but the logs are written by a long-lived process that
 * imports the whole trading stack, so the API applies its own last line of
 * defence rather than trusting an upstream guarantee.
 */
const LOG_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\botp=([^&\s"'`]+)/gi, "otp=[REDACTED]"],
  [/\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/g, "Bearer [REDACTED]"],
  [/\bory_[a-z]{2}_[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED]"],
  [/\b((?:access|refresh|id)_?token["']?\s*[:=]\s*["']?)([^"'\s,&}]+)/gi, "$1[REDACTED]"],
];

export function sanitizeLogText(text: string): string {
  let output = text;
  for (const [pattern, replacement] of LOG_REDACTIONS) output = output.replace(pattern, replacement);
  return output;
}

/** Last `maxLines` lines of `text`, bounded to `maxBytes` from the end. */
export function tailLines(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.split(/\r?\n/);
  const tail = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  if (Buffer.byteLength(tail, "utf8") <= maxBytes) return tail;
  return Buffer.from(tail, "utf8").subarray(-maxBytes).toString("utf8");
}

function readLogTail(file: string, maxLines: number, maxBytes: number): string | null {
  if (!existsSync(file)) return null;
  try {
    // Logs are capped by PM2 rotation, so reading the whole file is bounded in
    // practice; the response is still truncated below.
    const content = readFileSync(file, "utf8");
    return tailLines(sanitizeLogText(content), maxLines, maxBytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deploy preparation
// ---------------------------------------------------------------------------

/** Writes the bot's PM2 app config and returns its absolute path. */
function writePm2Config(botId: string): string {
  const config = pm2.buildPm2AppConfig({
    botId,
    botDir: botDir(botId),
    runtimeEntry: runtimeEntryPath(),
    logDir: botLogDir(botId),
  });
  const file = botPm2ConfigPath(botId);
  writeFileSync(file, `${JSON.stringify([config], null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

/**
 * Writes the bot's credential file at mode 0600.
 *
 * This is the ONE place a credential is persisted, and it is persisted
 * server-side inside the bot's own directory. It is never returned by any
 * endpoint, never logged, and never placed in the PM2 environment (which
 * `pm2 save` would snapshot into `~/.pm2/dump.pm2`).
 */
function writeCredentials(botId: string, accountId: string, accessToken: string, currency: string | null): void {
  const payload = {
    account_id: accountId,
    access_token: accessToken,
    ...(currency ? { currency } : {}),
  };
  writeFileSync(botCredentialPath(botId), `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Creates an initial stats file so the UI has something truthful to render. */
function ensureInitialStats(botId: string): void {
  const file = botStatsPath(botId);
  if (existsSync(file)) return;
  const empty = {
    botId,
    status: "stopped",
    startedAt: null,
    lastActivityAt: null,
    lastTradeAt: null,
    trades: 0,
    wins: 0,
    losses: 0,
    profit: 0,
    currency: null,
    uptimeSeconds: 0,
    error: null,
  };
  writeFileSync(file, `${JSON.stringify(empty, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, error_description: message });
}

/** Maps a thrown BotPathError/Pm2Error onto an HTTP response. */
function handleFailure(res: Response, error: unknown, context: string): void {
  if (error instanceof BotPathError) {
    sendError(res, 400, error.code, error.message);
    return;
  }
  if (error instanceof pm2.Pm2Error) {
    const status = error.code === "invalid_process_name" || error.code === "invalid_config_path" ? 400 : 502;
    sendError(res, status, error.code, error.message);
    return;
  }
  logger.error(
    { err: error instanceof Error ? error.message : "unknown", context },
    "[vps-bots] unexpected failure",
  );
  sendError(res, 500, "internal_error", "The operation could not be completed.");
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Wraps an async handler so a rejection becomes a typed error response. */
function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    void fn(req, res).catch((error: unknown) => handleFailure(res, error, `${req.method} ${req.path}`));
  };
}

function clampLines(raw: unknown, maximum: number): number {
  const parsed = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(parsed)) return maximum;
  return Math.min(Math.max(1, Math.floor(parsed)), maximum);
}

/** Every operation must act on a bot that exists on disk. */
function requireExistingBot(res: Response, botId: string): boolean {
  if (botDirExists(botId)) return true;
  sendError(res, 404, "bot_not_found", "No such bot.");
  return false;
}

async function replyWithBot(res: Response, status: number, botId: string, deps: VpsBotsDeps): Promise<void> {
  const bot = await buildPublicBot(botId, deps);
  if (!bot) {
    sendError(res, 404, "bot_not_found", "No such bot.");
    return;
  }
  res.status(status).json({ bot, limits: { maxBots: maxBots(), usedBots: listBotIds().length } });
}

export function createVpsBotsRouter(overrides: Partial<VpsBotsDeps> = {}): IRouter {
  const deps: VpsBotsDeps = { ...defaultDeps(), ...overrides };
  const router: IRouter = Router();

  // Raw XML body, scoped to THIS router only. app.ts's global JSON parser has an
  // application/json content type and never sees these requests, so the effective
  // limit is exactly MAX_XML_BYTES rather than a global relaxation.
  const xmlBody = express.text({ type: ["application/xml", "text/xml"], limit: MAX_XML_BYTES });

  // PROTECTED: process control and strategy contents are never public.
  router.use(deps.controlLimiter);
  router.use(deps.auth);

  // -------------------------------------------------------------------------
  // POST /api/vps-bots/upload  — store a strategy, allocate a server-side id
  // -------------------------------------------------------------------------
  router.post(
    "/upload",
    deps.uploadLimiter,
    xmlBody,
    wrap(async (req, res) => {
      const name = validateBotName(req.query["name"]);
      if (!name.ok) {
        sendError(res, 400, name.code, name.message);
        return;
      }

      const xml = validateStrategyXml(typeof req.body === "string" ? req.body : "");
      if (!xml.ok) {
        sendError(res, 400, xml.code, xml.message);
        return;
      }

      const auth = getDerivAuth(res);
      if (!auth) {
        // Only reachable if the auth middleware is misconfigured; fail closed.
        sendError(res, 401, "missing_token", "Sign in to manage VPS bots.");
        return;
      }

      // Capacity is a server-side fact: three bots on a 1 GB host.
      assertBotCapacity(listBotIds());

      // The id is allocated HERE. The client never supplies one, so it can never
      // influence a filesystem path.
      const record = createBotRecord(name.name, auth.accountId);
      ensureBotDir(record.botId);
      writeFileSync(botXmlPath(record.botId), xml.xml, { encoding: "utf8", mode: 0o600 });

      // XML is stored but the bot is NOT deployed and NOT started: deployment is
      // an explicit second step.
      upsertBotRecord(record);

      logger.info(
        { botId: record.botId, bytes: Buffer.byteLength(xml.xml, "utf8") },
        "[vps-bots] strategy uploaded",
      );
      await replyWithBot(res, 201, record.botId, deps);
    }),
  );


  // -------------------------------------------------------------------------
  // GET /api/vps-bots  — list every bot with live process state and statistics
  // -------------------------------------------------------------------------
  router.get(
    "/",
    wrap(async (_req, res) => {
      const ids = new Set<string>([...listBotIds(), ...listBotRecords().map((record) => record.botId)]);
      const ordered = [...ids].sort();

      const bots: PublicBot[] = [];
      for (const id of ordered) {
        const bot = await buildPublicBot(id, deps);
        if (bot) bots.push(bot);
      }

      res.json({ bots, limits: { maxBots: maxBots(), usedBots: ordered.length } });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/vps-bots/:id
  // -------------------------------------------------------------------------
  router.get(
    "/:id",
    wrap(async (req, res) => {
      const botId = assertValidBotId(req.params.id);
      await replyWithBot(res, 200, botId, deps);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/vps-bots/:id/deploy — prepare runtime, PM2 config and credential
  // -------------------------------------------------------------------------
  router.post(
    "/:id/deploy",
    wrap(async (req, res) => {
      const botId = assertValidBotId(req.params.id);
      if (!requireExistingBot(res, botId)) return;

      const auth = getDerivAuth(res);
      if (!auth || !auth.accountId) {
        sendError(res, 400, "no_account", "No Deriv account is available for this session.");
        return;
      }

      // Re-validate the stored strategy: the file on disk is the artifact that
      // will actually run, so it is checked here rather than trusted from upload.
      const xml = validateStrategyXml(readFileSync(botXmlPath(botId), "utf8"));
      if (!xml.ok) {
        sendError(res, 409, "stored_strategy_invalid", "The stored strategy failed validation.");
        return;
      }

      ensureBotDir(botId);
      const configFile = writePm2Config(botId);
      writeCredentials(botId, auth.accountId, auth.accessToken, auth.currency);
      ensureInitialStats(botId);

      const now = new Date().toISOString();
      const existing = getBotRecord(botId);
      upsertBotRecord({
        botId,
        name: existing?.name ?? botId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        deploymentStatus: "deployed",
        deployedAt: now,
        accountId: auth.accountId,
      });

      logger.info({ botId, configFile }, "[vps-bots] bot deployed (process not started)");
      await replyWithBot(res, 200, botId, deps);
    }),
  );


  /** Shared guard for the three process-control verbs. */
  const requireDeployed = (botId: string, res: Response): boolean => {
    if (!requireExistingBot(res, botId)) return false;
    if (!existsSync(botPm2ConfigPath(botId))) {
      sendError(res, 409, "not_deployed", "Deploy this bot before starting it.");
      return false;
    }
    return true;
  };

  // -------------------------------------------------------------------------
  // POST /api/vps-bots/:id/start
  // -------------------------------------------------------------------------
  router.post(
    "/:id/start",
    wrap(async (req, res) => {
      const botId = assertValidBotId(req.params.id);
      if (!requireDeployed(botId, res)) return;

      await deps.pm2.startBot(botId, botPm2ConfigPath(botId));
      if (deps.pm2Save) await deps.pm2.saveDump();

      logger.info({ botId, process: pm2ProcessName(botId) }, "[vps-bots] bot start requested");
      await replyWithBot(res, 200, botId, deps);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/vps-bots/:id/stop
  // -------------------------------------------------------------------------
  router.post(
    "/:id/stop",
    wrap(async (req, res) => {
      const botId = assertValidBotId(req.params.id);
      if (!requireExistingBot(res, botId)) return;

      await deps.pm2.stopBot(botId);
      logger.info({ botId, process: pm2ProcessName(botId) }, "[vps-bots] bot stop requested");
      await replyWithBot(res, 200, botId, deps);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/vps-bots/:id/restart
  // -------------------------------------------------------------------------
  router.post(
    "/:id/restart",
    wrap(async (req, res) => {
      const botId = assertValidBotId(req.params.id);
      if (!requireDeployed(botId, res)) return;

      // Restarting a bot whose process is gone is a start: `pm2 restart` only
      // works on a process PM2 already knows about.
      const existing = await deps.pm2.describeBot(botId, undefined);
      if (existing) await deps.pm2.restartBot(botId);
      else await deps.pm2.startBot(botId, botPm2ConfigPath(botId));

      if (deps.pm2Save) await deps.pm2.saveDump();

      logger.info({ botId, process: pm2ProcessName(botId), hadProcess: Boolean(existing) }, "[vps-bots] bot restart requested");
      await replyWithBot(res, 200, botId, deps);
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/vps-bots/:id
  //
  // Not in the original route sketch, but required for operability: the host
  // supports three bots, so without a delete there is no way to free a slot.
  // -------------------------------------------------------------------------
  router.delete(
    "/:id",
    wrap(async (req, res) => {
      const botId = assertValidBotId(req.params.id);
      if (!requireExistingBot(res, botId)) return;

      try {
        // `delete` is a no-op-ish error when PM2 does not know the process, which
        // must not block removing the directory.
        await deps.pm2.deleteBot(botId);
      } catch (error) {
        logger.warn(
          { botId, err: error instanceof Error ? error.message : "unknown" },
          "[vps-bots] pm2 delete failed during removal",
        );
      }

      rmSync(botDir(botId), { recursive: true, force: true });
      removeBotRecord(botId);

      logger.info({ botId }, "[vps-bots] bot removed");
      res.status(204).end();
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/vps-bots/:id/logs — bounded, sanitised log tail
  // -------------------------------------------------------------------------
  router.get(
    "/:id/logs",
    wrap(async (req, res) => {
      const botId = assertValidBotId(req.params.id);
      if (!requireExistingBot(res, botId)) return;

      const lines = clampLines(req.query["lines"], deps.maxLogLines);
      const perStreamBytes = Math.floor(deps.maxLogBytes / 2);

      const stdout = readLogTail(botLogPath(botId, "out"), lines, perStreamBytes);
      const stderr = readLogTail(botLogPath(botId, "error"), lines, perStreamBytes);

      res.json({
        botId,
        lines,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        // Explicit, so the UI can say "showing fewer lines" rather than silently
        // presenting a partial picture as complete.
        truncated: (stdout ?? "").split("\n").length >= lines || (stderr ?? "").split("\n").length >= lines,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/vps-bots/:id/stats
  // -------------------------------------------------------------------------
  router.get(
    "/:id/stats",
    wrap(async (req, res) => {
      const botId = assertValidBotId(req.params.id);
      if (!requireExistingBot(res, botId)) return;
      res.json({ botId, stats: readPublicStats(botId) });
    }),
  );

  return router;
}

/** Router instance mounted by routes/index.ts. */
const vpsBotsRouter: IRouter = createVpsBotsRouter();

export default vpsBotsRouter;
