import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Trust proxy hops for correct client IPs / protocol behind an edge load
// balancer (e.g. DigitalOcean App Platform, NLB/ALB, Caddy reverse proxy).
//
// On plain EC2 the server binds directly to the public interface, so no
// proxy hop exists — trusting one hop there would let any client forge
// X-Forwarded-For and bypass IP-based rate limiting. `TRUST_PROXY` is
// therefore opt-in: set `TRUST_PROXY=1` only when deploying behind a proxy
// that strips/overwrites X-Forwarded-* headers at the edge.
const TRUST_PROXY = Number(process.env["TRUST_PROXY"] ?? "0");
app.set("trust proxy", TRUST_PROXY > 0 ? TRUST_PROXY : false);

// Fix 4: Security headers via Helmet (recommended defaults).
app.use(helmet());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Fix 3: Restrict CORS to an environment-configured allowlist.
// Set ALLOWED_ORIGINS to a comma-separated list of allowed origins.
// Example: ALLOWED_ORIGINS=https://your-frontend.com,http://localhost:5173
//
// Fail fast in production: silently falling back to the localhost defaults
// would mean the real frontend origin gets rejected by CORS, surfacing as a
// wall of confusing browser CORS errors instead of a clear boot-time error.
if (process.env.NODE_ENV === "production" && !process.env.ALLOWED_ORIGINS) {
  throw new Error(
    "ALLOWED_ORIGINS must be set in production — refusing to start with an insecure localhost CORS fallback.",
  );
}

const rawOrigins =
  process.env.ALLOWED_ORIGINS ?? "http://localhost:3000,http://localhost:5173";
const allowedOrigins = rawOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server requests (no Origin header) and listed origins.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${origin}' is not allowed`));
      }
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "Deriv Edge API",
    status: "ok",
    version: process.env["npm_package_version"] ?? "unknown",
    health: "/api/healthz",
  });
});

app.use("/api", router);

export default app;
