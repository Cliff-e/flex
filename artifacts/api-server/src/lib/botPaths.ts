/**
 * Centralised filesystem layout for VPS bots.
 *
 * SECURITY MODEL
 * --------------
 * A bot id is the ONLY identifier the browser ever supplies, and even that is
 * checked here before use. Every path is derived server-side from the id:
 *
 *   /opt/flex-bots/
 *     registry.json          <- metadata (see botRegistry.ts)
 *     runtime/
 *       bot-runtime.mjs      <- ONE shared bundle, never per bot
 *     bot-001/
 *       bot.xml
 *       stats.json           <- written by the runtime
 *       credentials.json     <- 0600, written by the backend on deploy
 *       pm2.config.json      <- generated PM2 app config for this bot
 *       logs/
 *         out.log
 *         error.log
 *
 * There is no function anywhere that accepts a filesystem path from a client,
 * and no `path.join` call in this module takes a caller-supplied path segment.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Bot ids are generated server-side: bot-001 … bot-999. */
export const BOT_ID_PATTERN = /^bot-\d{3}$/;

/** PM2 process names are derived from the bot id, never from user input. */
export const PM2_NAME_PREFIX = "vps-bot-";
export const PM2_NAME_PATTERN = /^vps-bot-bot-\d{3}$/;

/** Files inside a bot directory. */
export const BOT_XML_FILENAME = "bot.xml";
export const BOT_STATS_FILENAME = "stats.json";
export const BOT_CREDENTIAL_FILENAME = "credentials.json";
export const BOT_PM2_CONFIG_FILENAME = "pm2.config.json";
export const BOT_LOG_DIRNAME = "logs";
export const BOT_OUT_LOG_FILENAME = "out.log";
export const BOT_ERROR_LOG_FILENAME = "error.log";

/** Shared, per-host runtime bundle directory. */
export const RUNTIME_DIRNAME = "runtime";
export const RUNTIME_ENTRY_FILENAME = "bot-runtime.mjs";

/** Initial supported bot count for the 1 GB EC2 instance. Server-side, not UI. */
export const DEFAULT_MAX_BOTS = 3;
export const DEFAULT_BOTS_ROOT = "/opt/flex-bots";

export class BotPathError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BotPathError";
    this.code = code;
  }
}

/** True when `id` is a well-formed, server-generated bot id. */
export function isValidBotId(id: unknown): id is string {
  return typeof id === "string" && BOT_ID_PATTERN.test(id);
}

/**
 * Rejects anything that is not a valid bot id.
 *
 * Callers pass the raw route parameter straight in, so this is the single choke
 * point that makes path traversal, absolute paths and shell metacharacters
 * impossible to express.
 */
export function assertValidBotId(id: unknown): string {
  if (!isValidBotId(id)) {
    throw new BotPathError("invalid_bot_id", "Bot id must match bot-### (e.g. bot-001)");
  }
  return id;
}

/** Root that holds every bot directory. Overridable for staging/testing. */
export function botsRoot(): string {
  const configured = process.env["FLEX_BOTS_ROOT"];
  return path.resolve(configured && configured.trim() !== "" ? configured : DEFAULT_BOTS_ROOT);
}

/** Maximum number of bots this host is allowed to run concurrently. */
export function maxBots(): number {
  const raw = Number(process.env["FLEX_BOTS_MAX"] ?? String(DEFAULT_MAX_BOTS));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_BOTS;
}

export function runtimeDir(): string {
  return path.join(botsRoot(), RUNTIME_DIRNAME);
}

/** Absolute path of the shared headless runtime bundle. */
export function runtimeEntryPath(): string {
  const configured = process.env["FLEX_BOTS_RUNTIME_ENTRY"];
  if (configured && configured.trim() !== "") return path.resolve(configured);
  return path.join(runtimeDir(), RUNTIME_ENTRY_FILENAME);
}

/** Absolute path of a bot's isolated directory. */
export function botDir(id: unknown): string {
  return path.join(botsRoot(), assertValidBotId(id));
}

export function botXmlPath(id: unknown): string {
  return path.join(botDir(id), BOT_XML_FILENAME);
}

export function botStatsPath(id: unknown): string {
  return path.join(botDir(id), BOT_STATS_FILENAME);
}

export function botCredentialPath(id: unknown): string {
  return path.join(botDir(id), BOT_CREDENTIAL_FILENAME);
}

export function botPm2ConfigPath(id: unknown): string {
  return path.join(botDir(id), BOT_PM2_CONFIG_FILENAME);
}

export function botLogDir(id: unknown): string {
  return path.join(botDir(id), BOT_LOG_DIRNAME);
}

export function botLogPath(id: unknown, stream: "out" | "error"): string {
  const filename = stream === "out" ? BOT_OUT_LOG_FILENAME : BOT_ERROR_LOG_FILENAME;
  return path.join(botLogDir(id), filename);
}

export function registryPath(): string {
  return path.join(botsRoot(), "registry.json");
}

/** PM2 process name for a bot. Never accepts a caller-supplied name. */
export function pm2ProcessName(id: unknown): string {
  return `${PM2_NAME_PREFIX}${assertValidBotId(id)}`;
}

/** True when `candidate` is inside `parent` (defence-in-depth assert). */
export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function ensureBotsRoot(): void {
  mkdirSync(botsRoot(), { recursive: true });
}

/** Creates the standard directory tree for a bot (idempotent). */
export function ensureBotDir(id: unknown): string {
  const dir = botDir(id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(botLogDir(id), { recursive: true });

  // Defence in depth: the derived paths must really be inside the bots root.
  if (!isPathInside(botsRoot(), dir)) {
    throw new BotPathError("path_escape", "Refusing to use a bot directory outside FLEX_BOTS_ROOT");
  }
  return dir;
}

export function botDirExists(id: unknown): boolean {
  try {
    return existsSync(botDir(id)) && statSync(botDir(id)).isDirectory();
  } catch {
    return false;
  }
}

/** All bot ids currently on disk, sorted ascending. */
export function listBotIds(): string[] {
  const root = botsRoot();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && BOT_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Allocates the next bot id server-side.
 *
 * The browser never chooses an id, so it can never choose a path.
 */
export function nextBotId(existing: readonly string[] = listBotIds()): string {
  const used = new Set(existing);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `bot-${String(index).padStart(3, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new BotPathError("capacity_exhausted", "No bot ids remain (maximum is bot-999)");
}

/** Throws when adding another bot would exceed the configured maximum. */
export function assertBotCapacity(existing: readonly string[] = listBotIds()): void {
  const limit = maxBots();
  if (existing.length >= limit) {
    throw new BotPathError(
      "capacity_reached",
      `This server supports at most ${limit} bots. Remove one before adding another.`,
    );
  }
}
