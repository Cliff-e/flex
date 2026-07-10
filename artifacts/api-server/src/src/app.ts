import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Trust the first proxy hop (DigitalOcean App Platform's load balancer
// terminates TLS at the edge and forwards plain HTTP internally). Without
// this, req.ip/req.protocol/req.secure would reflect the internal LB hop
// instead of the real client — breaking IP-based rate limiting, request
// logging, and any HTTPS-aware logic.
//
// `1` = trust exactly one hop in front of us. App Platform's edge is the
// only proxy between the internet and this single-instance service, so
// this is safe without also trusting arbitrary spoofed X-Forwarded-* chains.
app.set("trust proxy", 1);

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

app.use("/api", router);

export default app;
