/**
 * PHASE 2 GATE - the secure VPS bot API.
 *
 * Run: node scripts/verify-phase2.mjs   (or `npm run verify:phase2`)
 *
 * WHAT THIS PROVES, AND HOW
 * -------------------------
 *   The REAL router, the REAL auth middleware and the REAL PM2 adapter are
 *   driven over real HTTP against a real listening server. PM2 itself is replaced
 *   by a stub program invoked through the production `execFile` path, so the
 *   argument arrays, the `shell: false` option and the process names are the ones
 *   production would use - they are observed, not assumed.
 *
 *   Two apps are exercised:
 *     - App R: the REAL `src/app.ts` (health + auth + vps-bots, production
 *       wiring). Proves the existing routes still work and that /api/vps-bots is
 *       genuinely protected.
 *     - App T: the same router with an injected credential verifier, so every
 *       authentication branch can be tested without calling Deriv.
 *
 * HONESTY NOTE: no live Deriv credential is used and no live trade occurs here.
 * This gate is about the API's security and lifecycle behaviour. Live
 * authenticated verification is Phase 4.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Environment first: several modules read it at import time.
// ---------------------------------------------------------------------------

const workRoot = path.join(tmpdir(), "flex-bots-phase2-verify");
rmSync(workRoot, { recursive: true, force: true });
mkdirSync(workRoot, { recursive: true });

const botsRoot = path.join(workRoot, "flex-bots");
const pm2StubPath = path.join(workRoot, "stub-pm2.mjs");
const pm2StatePath = path.join(workRoot, "pm2-state.json");
const pm2LogPath = path.join(workRoot, "pm2-calls.jsonl");

process.env["NODE_ENV"] = "production";
process.env["LOG_LEVEL"] = "silent";
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["SESSION_SECRET"] = "phase2-gate-session-secret-not-production";
// Supplied so the EXISTING auth routes pass their own configuration guard and
// can be asserted on their real behaviour (401 without a token) rather than
// returning 503 for a missing variable.
process.env["VITE_DERIV_APP_ID"] = "33gBzpTA0Py8ehX45PBxR";
process.env["API_BASE_URL"] = "https://api.example.invalid";
process.env["FRONTEND_URL"] = "https://frontend.example.invalid";
process.env["FLEX_BOTS_ROOT"] = botsRoot;
process.env["FLEX_BOTS_MAX"] = "3";
process.env["PM2_BIN"] = pm2StubPath;
process.env["FLEX_BOTS_PM2_SAVE"] = "1";
process.env["STUB_PM2_STATE"] = pm2StatePath;
process.env["STUB_PM2_LOG"] = pm2LogPath;

/**
 * Stub PM2 program.
 *
 * Invoked by the production `execFile` path with the same fixed argument arrays a
 * real PM2 would receive. It records every call and keeps a tiny process list, so
 * the gate can assert exactly what production would have executed.
 */
const STUB_PM2_SOURCE = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const logPath = process.env.STUB_PM2_LOG;
const statePath = process.env.STUB_PM2_STATE;
const args = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify({ args }) + "\\n");

const readState = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { procs: [] });
const writeState = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));
const state = readState();
const [verb, target] = args;

if (verb === "jlist") {
  const out = state.procs.map((proc) => ({
    name: proc.name,
    pid: proc.status === "online" ? 4400 : 0,
    pm2_env: { status: proc.status, restart_time: proc.restarts, pm_uptime: Date.now() - 5000 },
    monit: { memory: 48 * 1024 * 1024 },
  }));
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
if (verb === "start") {
  const config = JSON.parse(readFileSync(target, "utf8"))[0];
  if (!state.procs.some((proc) => proc.name === config.name)) {
    state.procs.push({ name: config.name, status: "online", restarts: 0 });
    writeState(state);
  }
  process.exit(0);
}
if (verb === "restart" || verb === "stop") {
  const proc = state.procs.find((candidate) => candidate.name === target);
  if (!proc) { process.stderr.write("process not found"); process.exit(1); }
  if (verb === "restart") { proc.status = "online"; proc.restarts += 1; } else { proc.status = "stopped"; }
  writeState(state);
  process.exit(0);
}
if (verb === "delete") {
  state.procs = state.procs.filter((proc) => proc.name !== target);
  writeState(state);
  process.exit(0);
}
if (verb === "save") {
  writeFileSync(statePath + ".dump", JSON.stringify(state));
  process.exit(0);
}
process.stderr.write("stub pm2: unsupported verb " + args.join(" "));
process.exit(1);
`;

writeFileSync(pm2StubPath, STUB_PM2_SOURCE, "utf8");
writeFileSync(pm2LogPath, "", "utf8");
// A pre-existing, NON-managed process. The gate checks it is never touched.
writeFileSync(pm2StatePath, JSON.stringify({ procs: [{ name: "flex-api", status: "online", restarts: 0 }] }, null, 2));

// ---------------------------------------------------------------------------
// Modules under test (imported dynamically, after the environment is set)
// ---------------------------------------------------------------------------

import express from "express";
import type { Server } from "node:http";

const { createVpsBotsRouter } = await import("../routes/vpsBots");
const { createRequireDerivAuth } = await import("../lib/requireDerivAuth");
const { validateStrategyXml, MAX_XML_BYTES } = await import("../lib/validateBotXml");
const botPaths = await import("../lib/botPaths");
const pm2Control = await import("../lib/pm2Control");
const {
  buildPm2AppConfig,
  assertManagedProcessName,
  parseJlist,
  Pm2Error,
} = pm2Control;

const VALID_TOKEN = "ory_at_phase2gatevalidtoken000000000000000000";
const OTHER_TOKEN = "ory_at_phase2gateinvalidtoken00000000000000";

// ---------------------------------------------------------------------------
// Tiny assertion harness (same style as the Phase 0/1 gates)
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];
const responseBodies: string[] = [];

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    const line = `${name}${detail ? ` — ${detail}` : ""}`;
    failures.push(line);
    console.log(`  FAIL  ${line}`);
  }
}

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------

type ApiResult = { status: number; body: string; json: unknown };

async function request(
  base: string,
  route: string,
  options: { method?: string; token?: string | null; body?: string; contentType?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  if (options.contentType) headers["Content-Type"] = options.contentType;
  if (options.body !== undefined && !options.contentType) headers["Content-Type"] = "application/json";

  const response = await fetch(`${base}${route}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
  });
  const body = await response.text();
  responseBodies.push(body);

  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  return { status: response.status, body, json };
}

function listen(app: express.Express): Promise<{ base: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, server });
    });
  });
}

function readPm2State(): { procs: Array<{ name: string; status: string; restarts: number }> } {
  if (!existsSync(pm2StatePath)) return { procs: [] };
  return JSON.parse(readFileSync(pm2StatePath, "utf8"));
}

function readPm2Calls(): Array<{ args: string[] }> {
  if (!existsSync(pm2LogPath)) return [];
  return readFileSync(pm2LogPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { args: string[] });
}

/** Every PM2 verb this module is allowed to use. */
const ALLOWED_PM2_VERBS = new Set(["jlist", "start", "restart", "stop", "delete", "save"]);

/**
 * Process-CONTROL invocations only.
 *
 * `jlist` is a read: every listing and health check calls it. Counting reads as
 * "commands run" would make the assertions meaningless, so the upload/deploy
 * checks count only verbs that change process state.
 */
function controlInvocations(): Array<{ file: string; args: string[] }> {
  return pm2Control
    .recentPm2Invocations()
    .filter((invocation) => !["jlist"].includes(invocation.args[1] ?? ""))
    .map((invocation) => ({ file: invocation.file, args: [...invocation.args] }));
}

const SHELL_METACHARACTERS = /[;&|`$><\n\r*?[\]{}()!#~]/;

/** A valid, realistic strategy document (the same shape the app ships). */
const STRATEGY_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<xml xmlns=\"https://developers.google.com/blockly/xml\">",
  '  <block type="trade_definition" id="td">',
  '    <statement name="TRADE_OPTIONS">',
  '      <block type="trade_definition_market" id="mkt">',
  '        <field name="SYMBOL_LIST">R_100</field>',
  "      </block>",
  "    </statement>",
  "  </block>",
  "</xml>",
  "",
].join("\n");


/** True when the async call rejected. */
async function expectRejected(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

function expectThrows(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// A. Path, id and PM2 primitives
// ---------------------------------------------------------------------------

section("A. Path, id and PM2 primitives");
{
  check("valid ids accepted", botPaths.isValidBotId("bot-001") && botPaths.isValidBotId("bot-999"));
  check(
    "traversal / absolute / metacharacter ids rejected",
    !botPaths.isValidBotId("../etc") &&
      !botPaths.isValidBotId("..") &&
      !botPaths.isValidBotId("/") &&
      !botPaths.isValidBotId("\\") &&
      !botPaths.isValidBotId("C:") &&
      !botPaths.isValidBotId("bot-001; rm -rf /") &&
      !botPaths.isValidBotId("bot-001/../bot-002") &&
      !botPaths.isValidBotId("bot-1") &&
      !botPaths.isValidBotId("BOT-001") &&
      !botPaths.isValidBotId(undefined) &&
      !botPaths.isValidBotId(42),
  );

  check("assertValidBotId throws a typed error", expectThrows(() => botPaths.assertValidBotId("bot-001/../../etc")));
  check(
    "botDir is always inside the bots root",
    botPaths.isPathInside(botsRoot, botPaths.botDir("bot-001")) &&
      botPaths.botDir("bot-002").startsWith(botsRoot),
  );
  check(
    "derived file paths stay inside the bot directory",
    ["xml", "stats", "credential", "pm2config", "logdir"].every((kind) => {
      const target =
        kind === "xml"
          ? botPaths.botXmlPath("bot-001")
          : kind === "stats"
            ? botPaths.botStatsPath("bot-001")
            : kind === "credential"
              ? botPaths.botCredentialPath("bot-001")
              : kind === "pm2config"
                ? botPaths.botPm2ConfigPath("bot-001")
                : botPaths.botLogDir("bot-001");
      return botPaths.isPathInside(botPaths.botDir("bot-001"), target);
    }),
  );
  check("process names are derived, never supplied", botPaths.pm2ProcessName("bot-001") === "vps-bot-bot-001");
  check(
    "nextBotId allocates server-side",
    botPaths.nextBotId([]) === "bot-001" && botPaths.nextBotId(["bot-001"]) === "bot-002",
  );
  check("maxBots is server-side configurable", botPaths.maxBots() === 3, String(botPaths.maxBots()));

  // --- PM2: arbitrary commands must be impossible --------------------------
  const before = pm2Control.recentPm2Invocations().length;

  const guards: Array<[string, () => Promise<unknown>]> = [
    ["stopBot with a shell metacharacter", () => pm2Control.stopBot("bot-001; rm -rf /")],
    ["restartBot on flex-api", () => pm2Control.restartBot("flex-api")],
    ["deleteBot with a traversal id", () => pm2Control.deleteBot("../bot-001")],
    ["startBot with a config outside the bot dir", () => pm2Control.startBot("bot-001", "/etc/passwd")],
    ["stopBot on a non-managed process name", () => pm2Control.stopBot("vps-bot-flex-api")],
  ];

  for (const [label, fn] of guards) {
    check(`rejected before execution: ${label}`, await expectRejected(fn));
  }

  check(
    "no PM2 command was executed for any rejected call",
    pm2Control.recentPm2Invocations().length === before,
    `${pm2Control.recentPm2Invocations().length} != ${before}`,
  );

  check(
    "assertManagedProcessName refuses flex-api",
    expectThrows(() => assertManagedProcessName("flex-api")) &&
      expectThrows(() => assertManagedProcessName("vps-bot-flex-api")),
  );
  check(
    "PM2 config builder refuses a foreign process name",
    expectThrows(() =>
      buildPm2AppConfig({
        botId: "bot-001",
        botDir: botPaths.botDir("bot-001"),
        runtimeEntry: path.join(workRoot, "bot-runtime.mjs"),
        logDir: botPaths.botLogDir("bot-001"),
        instanceName: "flex-api",
      }),
    ),
  );
  check(
    "PM2 config builder refuses a mismatched directory",
    expectThrows(() =>
      buildPm2AppConfig({
        botId: "bot-001",
        botDir: botPaths.botDir("bot-002"),
        runtimeEntry: path.join(workRoot, "bot-runtime.mjs"),
        logDir: botPaths.botLogDir("bot-001"),
      }),
    ),
  );

  const appConfig = buildPm2AppConfig({
    botId: "bot-001",
    botDir: botPaths.botDir("bot-001"),
    runtimeEntry: path.join(workRoot, "bot-runtime.mjs"),
    logDir: botPaths.botLogDir("bot-001"),
  });
  check("PM2 config uses the shared runtime bundle", appConfig.script === path.join(workRoot, "bot-runtime.mjs"));
  check("PM2 config cwd is the bot directory", appConfig.cwd === botPaths.botDir("bot-001"));
  check(
    "PM2 config logs live inside the bot directory",
    botPaths.isPathInside(botPaths.botLogDir("bot-001"), appConfig.out_file) &&
      botPaths.isPathInside(botPaths.botLogDir("bot-001"), appConfig.error_file),
  );
  check(
    "PM2 config environment carries NO credential",
    Object.keys(appConfig.env).every((key) => ["NODE_ENV", "BOT_ID", "BOT_DIR"].includes(key)),
    Object.keys(appConfig.env).join(","),
  );
  check(
    "PM2 config restarts are bounded (1 GB host)",
    appConfig.max_restarts <= 10 && appConfig.restart_delay >= 1000,
  );

  check("parseJlist maps process state", parseJlist(
    JSON.stringify([{ name: "vps-bot-bot-001", pid: 7, pm2_env: { status: "online", restart_time: 2, pm_uptime: Date.now() - 1000 }, monit: { memory: 1024 } }]),
  )[0]?.status === "online");
  check("parseJlist rejects non-JSON", expectThrows(() => parseJlist("not json")));
  check("Pm2Error is the typed failure", Pm2Error.name === "Pm2Error");
}


// ---------------------------------------------------------------------------
// Two live servers
// ---------------------------------------------------------------------------

let verifyCalls = 0;

/** Injected credential verifier: only VALID_TOKEN is accepted. */
const fakeVerify = async (token: string) => {
  verifyCalls += 1;
  if (token === VALID_TOKEN) {
    return {
      ok: true as const,
      context: {
        accessToken: token,
        accountId: "VRTC1234567",
        currency: "USD",
        accounts: [{ loginid: "VRTC1234567", currency: "USD" }],
      },
    };
  }
  return {
    ok: false as const,
    status: 401,
    code: "invalid_token",
    message: "Deriv rejected this session. Please sign in again.",
  };
};

// App T — the REAL router and REAL auth middleware with an injected verifier.
const testApp = express();
testApp.use(express.json());
// Mounted at the same path the real application uses.
testApp.use("/api/vps-bots", createVpsBotsRouter({ auth: createRequireDerivAuth(fakeVerify) }));
// A body-parser rejection (413) is an expected outcome in section D; Express's
// default handler prints the stack to stderr, which would drown the gate output.
testApp.use(
  (
    error: Error & { status?: number; type?: string },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(error.status ?? 500).json({ error: error.type ?? "error", error_description: "Request refused." });
  },
);
const testServer = await listen(testApp);

// App R — the REAL application (health + auth + vps-bots with production wiring).
const realApp = (await import("../app")).default;
const realServer = await listen(realApp);

// ---------------------------------------------------------------------------
// B. Authentication is enforced everywhere
// ---------------------------------------------------------------------------

section("B. Authentication is enforced");
{
  const protectedRoutes: Array<[string, string]> = [
    ["GET", "/api/vps-bots"],
    ["POST", "/api/vps-bots/upload?name=Volatility%20Bot"],
    ["GET", "/api/vps-bots/bot-001"],
    ["POST", "/api/vps-bots/bot-001/deploy"],
    ["POST", "/api/vps-bots/bot-001/start"],
    ["POST", "/api/vps-bots/bot-001/stop"],
    ["POST", "/api/vps-bots/bot-001/restart"],
    ["GET", "/api/vps-bots/bot-001/logs"],
    ["GET", "/api/vps-bots/bot-001/stats"],
    ["DELETE", "/api/vps-bots/bot-001"],
  ];

  const invocationsBefore = pm2Control.recentPm2Invocations().length;
  let allRejected = true;

  for (const [method, route] of protectedRoutes) {
    const result = await request(testServer.base, route, {
      method,
      token: null,
      body: method === "POST" ? STRATEGY_XML : undefined,
      contentType: method === "POST" ? "application/xml" : undefined,
    });
    if (result.status !== 401) allRejected = false;
  }
  check("every endpoint rejects an unauthenticated request with 401", allRejected);
  check(
    "no PM2 command ran for any unauthenticated request",
    pm2Control.recentPm2Invocations().length === invocationsBefore,
  );
  check("no bot directory was created by unauthenticated requests", botPaths.listBotIds().length === 0);

  const malformed = await fetch(`${testServer.base}/api/vps-bots`, { headers: { authorization: "Token abc" } });
  responseBodies.push(await malformed.clone().text());
  check("a malformed Authorization header is rejected", malformed.status === 401);

  const shortToken = await fetch(`${testServer.base}/api/vps-bots`, { headers: { authorization: "Bearer short" } });
  responseBodies.push(await shortToken.clone().text());
  check("an implausibly short token is rejected", shortToken.status === 401);

  const invalid = await request(testServer.base, "/api/vps-bots", { token: OTHER_TOKEN });
  check("a token Deriv does not accept is rejected", invalid.status === 401, String(invalid.status));

  const valid = await request(testServer.base, "/api/vps-bots", { token: VALID_TOKEN });
  check("a verified session is accepted", valid.status === 200, String(valid.status));
  check(
    "the verifier is consulted for every request that carries a token",
    verifyCalls === 2,
    String(verifyCalls),
  );
  check("the unauthenticated 401 body carries no token", !invalid.body.includes(VALID_TOKEN));
}

// ---------------------------------------------------------------------------
// C. Existing backend routes remain functional (real app, production wiring)
// ---------------------------------------------------------------------------

section("C. Existing backend routes remain functional");
{
  const health = await request(realServer.base, "/api/healthz");
  check("GET /api/healthz still returns ok", health.status === 200 && (health.json as { status?: string })?.status === "ok");

  const root = await request(realServer.base, "/");
  check("GET / still identifies the service", root.status === 200 && root.body.includes("Deriv Edge API"));

  const authAccounts = await request(realServer.base, "/api/auth/accounts");
  check("GET /api/auth/accounts still requires a token", authAccounts.status === 401, String(authAccounts.status));

  const authOtp = await request(realServer.base, "/api/auth/otp", {
    method: "POST",
    body: JSON.stringify({ account_id: "VRTC1234567" }),
  });
  check("POST /api/auth/otp still requires a token", authOtp.status === 401, String(authOtp.status));

  const unknown = await request(realServer.base, "/api/not-a-real-route");
  check("an unknown API route still 404s", unknown.status === 404, String(unknown.status));

  // The real app mounts the vps-bots router with production wiring.
  const realProtected = await request(realServer.base, "/api/vps-bots");
  check("the real app mounts /api/vps-bots behind auth", realProtected.status === 401, String(realProtected.status));
}


// ---------------------------------------------------------------------------
// D. Upload validation
// ---------------------------------------------------------------------------

section("D. Upload validation rejects bad input");
{
  const before = botPaths.listBotIds().length;
  const invocationsBefore = pm2Control.recentPm2Invocations().length;

  const cases: Array<[string, string, string]> = [
    ["not XML at all", "this is not xml at all", "invalid_xml"],
    ["unbalanced tags", "<xml><block></xml>", "invalid_xml"],
    ["wrong root element", "<strategy><block/></strategy>", "invalid_xml"],
    ["no block elements", "<xml></xml>", "invalid_xml"],
    ["DOCTYPE / XXE", '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><xml><block/></xml>', "invalid_xml"],
    ["ENTITY declaration", '<!ENTITY x "y"><xml><block/></xml>', "invalid_xml"],
    ["script content smuggled in", "<xml><block><script>alert(1)</script></block></xml>", "invalid_xml"],
    ["javascript: URI", '<xml><block><field name="url">javascript:alert(1)</field></block></xml>', "invalid_xml"],
    ["control characters", "<xml><block>\u0007</block></xml>", "invalid_xml"],
    ["empty body", "", "invalid_xml"],
  ];

  for (const [label, payload, expectedCode] of cases) {
    const result = await request(testServer.base, "/api/vps-bots/upload?name=Rejected", {
      method: "POST",
      token: VALID_TOKEN,
      body: payload,
      contentType: "application/xml",
    });
    const code = (result.json as { error?: string } | null)?.error;
    check(`rejected: ${label}`, result.status === 400 && code === expectedCode, `${result.status}/${String(code)}`);
  }

  check("no bot was created by any rejected upload", botPaths.listBotIds().length === before);
  check("no PM2 command ran for any rejected upload", pm2Control.recentPm2Invocations().length === invocationsBefore);

  // Oversized input, at both layers. The transport limit and the validator limit
  // are the same constant, so the transport rejects first; the validator's own
  // bound is asserted directly against the exported constant.
  const oversizedBody = `<xml>${'<block type="x"/>'.repeat(40_000)}</xml>`;
  const oversized = await request(testServer.base, "/api/vps-bots/upload?name=Huge", {
    method: "POST",
    token: VALID_TOKEN,
    body: oversizedBody,
    contentType: "application/xml",
  });
  check("an oversized body is refused at the transport layer", oversized.status === 413, String(oversized.status));
  check(
    "the validator rejects an oversized document on its own bound",
    validateStrategyXml(`<xml>${"<block/>".repeat(MAX_XML_BYTES / 8)}</xml>`).ok === false &&
      (validateStrategyXml(`<xml>${"<block/>".repeat(MAX_XML_BYTES / 8)}</xml>`) as { code?: string }).code ===
        "xml_too_large",
  );
  check("MAX_XML_BYTES is a real bound", MAX_XML_BYTES === 512 * 1024, String(MAX_XML_BYTES));

  const hugeBody = "x".repeat(700 * 1024);
  const huge = await request(testServer.base, "/api/vps-bots/upload?name=Huge", {
    method: "POST",
    token: VALID_TOKEN,
    body: hugeBody,
    contentType: "application/xml",
  });
  check("an oversized request body is refused", huge.status === 413 || huge.status === 400, String(huge.status));

  check("no bot was created by an oversized upload", botPaths.listBotIds().length === before);

  // An invalid bot name must not be usable to reach the filesystem.
  const badName = await request(testServer.base, "/api/vps-bots/upload?name=../../etc/passwd", {
    method: "POST",
    token: VALID_TOKEN,
    body: STRATEGY_XML,
    contentType: "application/xml",
  });
  check("a path-like bot name is rejected", badName.status === 400, String(badName.status));
}



// ---------------------------------------------------------------------------
// E. Upload succeeds; ids are allocated server-side; capacity is enforced
// ---------------------------------------------------------------------------

section("E. Upload works and allocates server-side ids");

const createdIds: string[] = [];
{
  const controlsBefore = controlInvocations().length;
  const names = ["Volatility Bot", "Volatility Bot 2", "Volatility Bot 3"];

  for (const name of names) {
    const result = await request(testServer.base, `/api/vps-bots/upload?name=${encodeURIComponent(name)}`, {
      method: "POST",
      token: VALID_TOKEN,
      body: STRATEGY_XML,
      contentType: "application/xml",
    });
    const bot = (result.json as { bot?: { botId?: string } } | null)?.bot;
    check(`upload accepted: ${name}`, result.status === 201 && typeof bot?.botId === "string", String(result.status));
    if (typeof bot?.botId === "string") createdIds.push(bot.botId);
  }

  check("ids are server-generated bot-###", createdIds.join(",") === "bot-001,bot-002,bot-003", createdIds.join(","));
  check(
    "no PM2 CONTROL command ran during upload (upload never starts a bot)",
    controlInvocations().length === controlsBefore,
    `${controlInvocations().length} != ${controlsBefore}`,
  );
  check(
    "bot.xml was persisted for every bot",
    createdIds.length === 3 && createdIds.every((id) => existsSync(botPaths.botXmlPath(id))),
  );
  check(
    "the stored strategy is the uploaded document",
    createdIds.length === 3 && readFileSync(botPaths.botXmlPath("bot-001"), "utf8") === STRATEGY_XML.trim(),
  );

  const list = await request(testServer.base, "/api/vps-bots", { token: VALID_TOKEN });
  const listJson = list.json as {
    bots: Array<{
      botId: string;
      name: string;
      deployment: { status: string };
      process: { managed: boolean; status: string };
      stats: unknown;
    }>;
    limits: { maxBots: number; usedBots: number };
  };

  check("list returns every bot", listJson.bots.length === 3, String(listJson.bots.length));
  check("list reports the server-side cap", listJson.limits.maxBots === 3 && listJson.limits.usedBots === 3);
  check(
    "a freshly uploaded bot is NOT running",
    listJson.bots.every((bot) => bot.process.managed === false && bot.process.status === "offline"),
  );
  check(
    "a freshly uploaded bot is not deployed",
    listJson.bots.every((bot) => bot.deployment.status === "uploaded"),
  );
  check("the bot name is stored", listJson.bots[0]?.name === "Volatility Bot", String(listJson.bots[0]?.name));

  const overflow = await request(testServer.base, "/api/vps-bots/upload?name=Fourth", {
    method: "POST",
    token: VALID_TOKEN,
    body: STRATEGY_XML,
    contentType: "application/xml",
  });
  check(
    "a fourth bot is refused (the host supports three)",
    overflow.status === 400 && (overflow.json as { error?: string })?.error === "capacity_reached",
    `${overflow.status}/${String((overflow.json as { error?: string })?.error)}`,
  );
  check("the refused upload created nothing", botPaths.listBotIds().length === 3);
}

// ---------------------------------------------------------------------------
// G. Invalid ids and path traversal are rejected
// ---------------------------------------------------------------------------

section("G. Invalid ids and path traversal are rejected");
{
  const invocationsBefore = pm2Control.recentPm2Invocations().length;
  const badIds = [
    "..%2F..%2Fetc",
    "%2E%2E%2Fetc",
    "bot-1",
    "bot-0001",
    "BOT-001",
    "bot-abc",
    "no-such-bot",
    "__proto__",
    "constructor",
    "bot-001%3Brm%20-rf%20%2F",
  ];

  let allRejected = true;
  for (const id of badIds) {
    const result = await request(testServer.base, `/api/vps-bots/${id}`, { token: VALID_TOKEN });
    const code = (result.json as { error?: string } | null)?.error;
    if (result.status !== 400 || code !== "invalid_bot_id") allRejected = false;
  }
  check("every malformed id is rejected with invalid_bot_id", allRejected);

  let verbsRejected = true;
  for (const verb of ["deploy", "start", "stop", "restart"]) {
    const result = await request(testServer.base, `/api/vps-bots/..%2F..%2Fetc/${verb}`, {
      method: "POST",
      token: VALID_TOKEN,
    });
    if (result.status !== 400) verbsRejected = false;
  }
  check("traversal is rejected on every control verb", verbsRejected);

  const removed = await request(testServer.base, "/api/vps-bots/..%2F..%2Fetc", {
    method: "DELETE",
    token: VALID_TOKEN,
  });
  check("traversal is rejected on DELETE", removed.status === 400, String(removed.status));

  check("no PM2 command ran for any rejected id", pm2Control.recentPm2Invocations().length === invocationsBefore);
  check("the filesystem is untouched by rejected ids", botPaths.listBotIds().length === 3);
  check("nothing was created outside the bots root", !existsSync(path.join(workRoot, "etc")));

  const missing = await request(testServer.base, "/api/vps-bots/bot-099", { token: VALID_TOKEN });
  check("a well-formed but unknown id returns 404", missing.status === 404, String(missing.status));
}

// ---------------------------------------------------------------------------
// H. Deployment (safe test mode: stub PM2 through the real execFile path)
// ---------------------------------------------------------------------------

section("H. Deployment works and does not start the process");
{
  const controlsBefore = controlInvocations().length;

  const notDeployedYet = await request(testServer.base, "/api/vps-bots/bot-001/start", {
    method: "POST",
    token: VALID_TOKEN,
  });
  check(
    "starting an undeployed bot is refused",
    notDeployedYet.status === 409 && (notDeployedYet.json as { error?: string })?.error === "not_deployed",
    `${notDeployedYet.status}/${String((notDeployedYet.json as { error?: string })?.error)}`,
  );
  check("the refused start ran no PM2 control command", controlInvocations().length === controlsBefore);

  const deploy = await request(testServer.base, "/api/vps-bots/bot-001/deploy", {
    method: "POST",
    token: VALID_TOKEN,
  });
  const deployed = (deploy.json as { bot?: { deployment?: { status?: string } } } | null)?.bot;
  check("deploy succeeds", deploy.status === 200, String(deploy.status));
  check("deploy records the deployment", deployed?.deployment?.status === "deployed");
  check(
    "DEPLOY DOES NOT START THE PROCESS",
    controlInvocations().length === controlsBefore,
    `${controlInvocations().length} != ${controlsBefore}`,
  );

  const configPath = botPaths.botPm2ConfigPath("bot-001");
  check("the PM2 config was written", existsSync(configPath));
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Array<Record<string, unknown>>;
  check("the PM2 config names the derived process", config[0]?.["name"] === "vps-bot-bot-001");
  check("the PM2 config points at the shared runtime", String(config[0]?.["script"]).includes("bot-runtime"));
  check("the PM2 config cwd is the bot directory", config[0]?.["cwd"] === botPaths.botDir("bot-001"));
  check(
    "the PM2 config environment holds no credential",
    Object.keys((config[0]?.["env"] ?? {}) as object).every((key) => ["NODE_ENV", "BOT_ID", "BOT_DIR"].includes(key)),
  );
  check(
    "PM2 config files are not world-readable where the platform enforces modes",
    process.platform === "win32" || (statSync(configPath).mode & 0o077) === 0,
  );

  const credentialPath = botPaths.botCredentialPath("bot-001");
  check("the credential file was written server-side", existsSync(credentialPath));
  check(
    "the credential file is restricted where the platform enforces modes",
    process.platform === "win32" || (statSync(credentialPath).mode & 0o077) === 0,
  );

  const initialStats = JSON.parse(readFileSync(botPaths.botStatsPath("bot-001"), "utf8")) as {
    status: string;
    trades: number;
  };
  check(
    "an initial stats file reports a truthful stopped state",
    initialStats.status === "stopped" && initialStats.trades === 0,
  );

  const statsEndpoint = await request(testServer.base, "/api/vps-bots/bot-001/stats", { token: VALID_TOKEN });
  check(
    "the stats endpoint returns the stored state",
    statsEndpoint.status === 200 &&
      (statsEndpoint.json as { stats?: { status?: string } })?.stats?.status === "stopped",
  );
  check(
    "STATS RESPONSE CONTAINS NO CREDENTIAL",
    !statsEndpoint.body.includes(VALID_TOKEN) && !statsEndpoint.body.includes("access_token"),
  );
}


// ---------------------------------------------------------------------------
// I. Process isolation: one bot at a time, `flex-api` untouched
// ---------------------------------------------------------------------------

section("I. Process isolation and PM2 command safety");
{
  await request(testServer.base, "/api/vps-bots/bot-002/deploy", { method: "POST", token: VALID_TOKEN });

  check(
    "the pre-existing non-managed process is present",
    readPm2State().procs.some((proc) => proc.name === "flex-api"),
  );

  const start1 = await request(testServer.base, "/api/vps-bots/bot-001/start", {
    method: "POST",
    token: VALID_TOKEN,
  });
  check("start succeeds", start1.status === 200, String(start1.status));
  check(
    "the started bot reports as managed and online",
    (start1.json as { bot?: { process?: { managed?: boolean; status?: string } } })?.bot?.process?.managed === true &&
      (start1.json as { bot?: { process?: { status?: string } } })?.bot?.process?.status === "online",
  );

  let state = readPm2State();
  check("the requested bot is online", state.procs.find((p) => p.name === "vps-bot-bot-001")?.status === "online");
  check(
    "flex-api was not restarted by starting a bot",
    state.procs.find((p) => p.name === "flex-api")?.restarts === 0 &&
      state.procs.find((p) => p.name === "flex-api")?.status === "online",
  );
  check("only the requested bot was created", state.procs.filter((p) => p.name.startsWith("vps-bot-")).length === 1);

  await request(testServer.base, "/api/vps-bots/bot-002/start", { method: "POST", token: VALID_TOKEN });
  state = readPm2State();
  check(
    "two bots run side by side",
    state.procs.find((p) => p.name === "vps-bot-bot-001")?.status === "online" &&
      state.procs.find((p) => p.name === "vps-bot-bot-002")?.status === "online",
  );

  await request(testServer.base, "/api/vps-bots/bot-002/stop", { method: "POST", token: VALID_TOKEN });
  state = readPm2State();
  check("stop affects only the requested bot", state.procs.find((p) => p.name === "vps-bot-bot-002")?.status === "stopped");
  check("the other bot keeps running", state.procs.find((p) => p.name === "vps-bot-bot-001")?.status === "online");

  await request(testServer.base, "/api/vps-bots/bot-001/restart", { method: "POST", token: VALID_TOKEN });
  state = readPm2State();
  check(
    "restart affects only the requested bot",
    state.procs.find((p) => p.name === "vps-bot-bot-001")?.restarts === 1 &&
      state.procs.find((p) => p.name === "vps-bot-bot-002")?.restarts === 0,
  );
  check(
    "RESTARTING A BOT DOES NOT RESTART flex-api",
    state.procs.find((p) => p.name === "flex-api")?.restarts === 0 &&
      state.procs.find((p) => p.name === "flex-api")?.status === "online",
  );

  // --- Command-level proof, from the stub PM2's own call log ----------------
  const calls = readPm2Calls();
  const verbs = calls.map((call) => call.args[0]);
  check("every PM2 verb used is on the allowlist", verbs.every((verb) => ALLOWED_PM2_VERBS.has(verb)), verbs.join(","));
  check(
    "no PM2 argument contains a shell metacharacter",
    calls.every((call) => call.args.every((arg) => !SHELL_METACHARACTERS.test(arg))),
  );
  check(
    "flex-api is never named in any PM2 command",
    !calls.some((call) => call.args.some((arg) => arg.includes("flex-api"))),
  );
  check(
    "only vps-bot-bot-### processes are ever targeted",
    calls
      .filter((call) => ["restart", "stop", "delete"].includes(call.args[0] ?? ""))
      .every((call) => /^vps-bot-bot-\d{3}$/.test(call.args[1] ?? "")),
  );

  const invocations = pm2Control.recentPm2Invocations();
  check(
    "PM2 is invoked as a file with a separate argument array",
    invocations.length > 0 && invocations.every((inv) => inv.file === process.execPath && inv.args[0] === pm2StubPath),
  );

  // The options the adapter passes to execFile are the security-relevant part
  // that cannot be observed after the fact, so they are captured directly.
  const spy: Array<{ file: string; args: string[]; shell: unknown; timeout: unknown; maxBuffer: unknown }> = [];
  await pm2Control.listProcesses(async (file, args, options) => {
    spy.push({ file, args: [...args], shell: options.shell, timeout: options.timeout, maxBuffer: options.maxBuffer });
    return { stdout: "[]", stderr: "" };
  });
  check("execFile is called with shell:false", spy[0]?.shell === false);
  check("execFile is bounded by a timeout", typeof spy[0]?.timeout === "number");
  check("execFile output is bounded by maxBuffer", typeof spy[0]?.maxBuffer === "number");
  check("the file and arguments are passed separately", Array.isArray(spy[0]?.args) && spy[0]?.args.length === 2);
}


// ---------------------------------------------------------------------------
// J. Credentials never reach a client
// ---------------------------------------------------------------------------

section("J. Credentials are never returned");
{
  const credentialPath = botPaths.botCredentialPath("bot-001");

  check("the credential file really exists on disk", existsSync(credentialPath));
  const stored = JSON.parse(readFileSync(credentialPath, "utf8")) as Record<string, unknown>;
  check("the credential file holds the session token server-side", stored["access_token"] === VALID_TOKEN);
  check("the credential file holds the account id", stored["account_id"] === "VRTC1234567");
  check(
    "the credential file lives inside the bot directory",
    botPaths.isPathInside(botPaths.botDir("bot-001"), credentialPath),
  );

  // Every response body produced by this gate, including the ones that were
  // expected to fail.
  const all = responseBodies.join("\n");
  check("no response body contains the access token", !all.includes(VALID_TOKEN));
  check("no response body contains an access_token field", !/"access_token"\s*:/.test(all));
  check("no response body contains a refresh_token field", !/refresh_token/.test(all));
  check("no response body contains an otp credential", !/\botp=/.test(all));
  check("no response body contains a Bearer token", !/Bearer\s+ory_/.test(all));

  // A direct sweep of the interesting endpoints, to be certain the aggregate
  // assertion above is not an artefact of what happened to be requested.
  const endpoints = [
    "/api/vps-bots",
    "/api/vps-bots/bot-001",
    "/api/vps-bots/bot-001/stats",
    "/api/vps-bots/bot-001/logs",
  ];
  let clean = true;
  for (const route of endpoints) {
    const result = await request(testServer.base, route, { token: VALID_TOKEN });
    if (result.body.includes(VALID_TOKEN) || result.body.includes("access_token")) clean = false;
  }
  check("no listing, detail, stats or logs response exposes a credential", clean);
}

// ---------------------------------------------------------------------------
// K. Logs are bounded and sanitised
// ---------------------------------------------------------------------------

section("K. Logs are bounded and sanitised");
{
  const logDir = botPaths.botLogDir("bot-001");
  writeFileSync(
    path.join(logDir, "out.log"),
    [
      "[bot-runtime] bot-001 starting",
      `leaked token ${VALID_TOKEN}`,
      "connecting wss://api.derivws.com/trading/v1/options/ws?otp=abcdef1234567890",
      `Authorization: Bearer ${VALID_TOKEN}`,
      "[bot-runtime] strategy started",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(path.join(logDir, "error.log"), "boom: something failed\n", "utf8");

  const logs = await request(testServer.base, "/api/vps-bots/bot-001/logs?lines=50", { token: VALID_TOKEN });
  const payload = logs.json as { stdout?: string; stderr?: string; lines?: number } | null;

  check("logs endpoint returns the stdout tail", payload?.stdout?.includes("[bot-runtime] bot-001 starting") === true);
  check("logs endpoint returns stderr separately", payload?.stderr?.includes("boom") === true);
  check("ACCESS TOKEN IS SCRUBBED FROM LOGS", !logs.body.includes(VALID_TOKEN));
  check("OTP credential is scrubbed from logs", !logs.body.includes("otp=abcdef1234567890"));
  check("scrubbed logs are visibly redacted", logs.body.includes("[REDACTED]"));

  const clamped = await request(testServer.base, "/api/vps-bots/bot-001/logs?lines=999999", { token: VALID_TOKEN });
  check("an oversized lines parameter is clamped", (clamped.json as { lines?: number })?.lines === 200);

  const emptyBot = await request(testServer.base, "/api/vps-bots/bot-002/logs", { token: VALID_TOKEN });
  check("a bot with no logs returns an empty tail rather than an error", emptyBot.status === 200);
}

// ---------------------------------------------------------------------------
// L. Removing a bot frees a capacity slot
// ---------------------------------------------------------------------------

section("L. Removing a bot frees capacity");
{
  const removed = await request(testServer.base, "/api/vps-bots/bot-003", { method: "DELETE", token: VALID_TOKEN });
  check("delete succeeds", removed.status === 204, String(removed.status));
  check("the bot directory is gone", !existsSync(botPaths.botDir("bot-003")));
  check(
    "the bot's PM2 process is gone",
    !readPm2State().procs.some((proc) => proc.name === "vps-bot-bot-003"),
  );
  check(
    "flex-api survived the delete",
    readPm2State().procs.some((proc) => proc.name === "flex-api" && proc.restarts === 0),
  );

  const reupload = await request(testServer.base, "/api/vps-bots/upload?name=Replacement", {
    method: "POST",
    token: VALID_TOKEN,
    body: STRATEGY_XML,
    contentType: "application/xml",
  });
  check(
    "a freed slot can be reused",
    reupload.status === 201 && (reupload.json as { bot?: { botId?: string } })?.bot?.botId === "bot-003",
    String(reupload.status),
  );

  const unauthDelete = await request(testServer.base, "/api/vps-bots/bot-001", { method: "DELETE", token: null });
  check("delete requires authentication", unauthDelete.status === 401, String(unauthDelete.status));
  check("the unauthenticated delete removed nothing", existsSync(botPaths.botDir("bot-001")));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

testServer.server.close();
realServer.server.close();
rmSync(workRoot, { recursive: true, force: true });

console.log(`\n[phase2] checks passed : ${passed}`);
console.log(`[phase2] checks failed : ${failures.length}`);

if (failures.length > 0) {
  console.log("[phase2] failures:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log("[phase2] GATE RESULT: PASS");
process.exit(0);
