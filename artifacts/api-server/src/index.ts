import http from "http";
import { WebSocketServer } from "ws";
import { getPool } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";

// Catch anything that would otherwise crash the process silently — App
// Platform just sees the container restart with no diagnostic context.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  process.exit(1);
});

const PORT = Number(process.env["PORT"] ?? 5000);

if (Number.isNaN(PORT) || PORT <= 0) {
  throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);
}

// Create a plain HTTP server so we can share it with the WS server.
const server = http.createServer(app);

// ── WebSocket layer ────────────────────────────────────────────────────────
// Attached to the same server instance as Express — no extra port required.
// Keeps WebSocket isolated from HTTP route handlers (trading-safe).
//
// This is a placeholder echo endpoint — it is NOT part of the production
// trading architecture. The real trading/market WebSockets
// (WebSocketManager, PublicMarketSocket) connect directly from the frontend
// to Deriv's own servers, never through this backend. Since it has no
// authentication and no per-connection limits, it is disabled in production
// to avoid leaving an unauthenticated, unbounded public WS endpoint exposed.
// Re-enable only once it either has a real purpose with auth, or is removed
// entirely.
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const wss = IS_PRODUCTION ? null : new WebSocketServer({ server, path: "/ws" });

if (wss) {
  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    logger.info({ ip }, "WebSocket client connected");

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        logger.debug({ msg }, "WS message received");
        // Echo back with server timestamp for now; replace with real handlers.
        ws.send(JSON.stringify({ ...msg, server_time: Date.now() }));
      } catch {
        ws.send(JSON.stringify({ error: "invalid json" }));
      }
    });

    ws.on("close", () => logger.info({ ip }, "WebSocket client disconnected"));
    ws.on("error", (err) => logger.warn({ err, ip }, "WebSocket error"));

    // Send a greeting so clients can confirm the connection.
    ws.send(JSON.stringify({ type: "connected", server_time: Date.now() }));
  });
}

// ── HTTP server ────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, "Server listening");
  if (wss) {
    logger.info({ wsPath: "/ws" }, "WebSocket server ready");
  } else {
    logger.info("WebSocket placeholder endpoint disabled in production");
  }
});

server.on("error", (err) => {
  logger.error({ err }, "HTTP server error");
  process.exit(1);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
// App Platform sends SIGTERM on deploys, restarts, and scaling events, then
// SIGKILLs after a grace period. Drain WS clients, stop accepting new HTTP
// connections, and close the DB pool before exiting so nothing is corrupted
// mid-request/mid-trade.
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutdown signal received — draining connections");

  const forceExitTimer = setTimeout(() => {
    logger.warn("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  let hadError = false;

  const wsClosed = new Promise<void>((resolve) => {
    if (!wss) {
      resolve();
      return;
    }
    for (const client of wss.clients) {
      client.close(1001, "Server shutting down");
    }
    wss.close((err) => {
      if (err) {
        hadError = true;
        logger.error({ err }, "Error while closing WebSocket server");
      }
      resolve();
    });
  });

  const httpClosed = new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) {
        hadError = true;
        logger.error({ err }, "Error while closing HTTP server");
      }
      resolve();
    });
  });

  Promise.all([wsClosed, httpClosed])
    .then(() => {
      // getPool() throws if DATABASE_URL was never set and the pool was
      // never initialised — in that case there is nothing to drain.
      try {
        return getPool()
          .end()
          .catch((poolErr: unknown) => {
            hadError = true;
            logger.error({ err: poolErr }, "Error while closing DB pool");
          });
      } catch {
        return Promise.resolve();
      }
    })
    .finally(() => {
      clearTimeout(forceExitTimer);
      logger.info(
        { hadError },
        hadError ? "Shutdown completed with errors" : "Shutdown complete",
      );
      process.exit(hadError ? 1 : 0);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
