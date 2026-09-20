/**
 * Bot metadata registry.
 *
 * DESIGN RULES
 * ------------
 *   1. This is METADATA ONLY. PM2 is the single source of truth for whether a
 *      process is running; the registry deliberately does not cache a runtime
 *      status, so the two can never disagree.
 *   2. A JSON file, not a database. The host is a t3.micro with an 8 GB gp3
 *      volume and this service is stateless today; adding a database for three
 *      rows of metadata would be a new failure mode for no benefit.
 *   3. No credential is ever stored here - only the Deriv login id the bot is
 *      configured for, which is not a secret.
 *   4. Writes are atomic (temp file + rename) at mode 0600, so a crash mid-write
 *      can never leave a truncated registry behind.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  assertValidBotId,
  ensureBotsRoot,
  listBotIds,
  nextBotId,
  registryPath,
} from "./botPaths";

/**
 * How far through the lifecycle a bot is.
 *
 * This is a DEPLOYMENT fact the backend owns:
 *   - `uploaded`: XML received and validated, nothing prepared on disk yet,
 *   - `deployed`: runtime config, logs and credential file written; ready to run.
 *
 * Whether the process is running comes from PM2, always.
 */
export type BotDeploymentStatus = "uploaded" | "deployed";

export type BotRecord = {
  botId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deploymentStatus: BotDeploymentStatus;
  deployedAt: string | null;
  /** Deriv login id the bot trades. Not a credential, safe to return. */
  accountId: string | null;
};

export type Registry = {
  version: 1;
  bots: BotRecord[];
};

/** Reads the registry, tolerating absence and corruption. */
export function readRegistry(): Registry {
  const file = registryPath();
  if (!existsSync(file)) return { version: 1, bots: [] };

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") return { version: 1, bots: [] };

    const bots = (parsed as { bots?: unknown }).bots;
    if (!Array.isArray(bots)) return { version: 1, bots: [] };

    return {
      version: 1,
      bots: bots.filter(isBotRecord),
    };
  } catch {
    // A corrupt registry must not take the API down; the bots themselves are
    // intact on disk and PM2 still knows about their processes.
    return { version: 1, bots: [] };
  }
}

function isBotRecord(value: unknown): value is BotRecord {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["botId"] === "string" &&
    typeof candidate["name"] === "string" &&
    typeof candidate["createdAt"] === "string" &&
    typeof candidate["deploymentStatus"] === "string"
  );
}

/** Writes the registry atomically at mode 0600. */
export function writeRegistry(registry: Registry): void {
  ensureBotsRoot();
  const file = registryPath();
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
}

export function listBotRecords(): BotRecord[] {
  return readRegistry().bots.slice().sort((a, b) => a.botId.localeCompare(b.botId));
}

export function getBotRecord(id: unknown): BotRecord | null {
  const botId = assertValidBotId(id);
  return readRegistry().bots.find((bot) => bot.botId === botId) ?? null;
}

/** Creates or replaces a bot record. */
export function upsertBotRecord(record: BotRecord): BotRecord {
  const registry = readRegistry();
  const index = registry.bots.findIndex((bot) => bot.botId === record.botId);
  if (index >= 0) registry.bots[index] = record;
  else registry.bots.push(record);
  writeRegistry(registry);
  return record;
}

export function removeBotRecord(id: unknown): boolean {
  const botId = assertValidBotId(id);
  const registry = readRegistry();
  const remaining = registry.bots.filter((bot) => bot.botId !== botId);
  if (remaining.length === registry.bots.length) return false;
  writeRegistry({ version: 1, bots: remaining });
  return true;
}

/** Creates a fresh `uploaded` record for a new bot id. */
export function createBotRecord(name: string, accountId: string | null, now = new Date()): BotRecord {
  const botId = nextBotId(listBotIds().concat(readRegistry().bots.map((bot) => bot.botId)));
  const timestamp = now.toISOString();
  return {
    botId,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    deploymentStatus: "uploaded",
    deployedAt: null,
    accountId,
  };
}

/**
 * True when `record` is one of the two known deployment states.
 *
 * Guards against a hand-edited registry putting an unknown value into an API
 * response, which would leave the UI unable to render a status.
 */
export function isDeploymentStatus(value: unknown): value is BotDeploymentStatus {
  return value === "uploaded" || value === "deployed";
}
