#!/usr/bin/env bash
#
# Phase 4 — deploy the VPS bot system onto the EXISTING EC2 host.
#
# WHAT THIS DOES
#   1. installs the workspace dependencies deterministically: pnpm install
#      --frozen-lockfile (package.json pins pnpm@10.26.1 and pnpm-lock.yaml is the
#      source of truth, so the host build resolves the same dependency graph)
#   2. builds the SHARED headless runtime bundle (one copy, no per-bot node_modules;
#      jsdom and ws are INLINED, so the installed file needs no node_modules)
#   3. installs it at $FLEX_BOTS_ROOT/runtime/bot-runtime.mjs, plus the tiny jsdom
#      xhr-sync-worker.js asset that jsdom resolves as it loads
#   4. builds the api-server and restarts ONLY `flex-api`
#   5. prints the environment variables the API needs
#
# WHAT THIS DELIBERATELY DOES NOT DO
#   * it does not provision anything,
#   * it does not introduce Docker, Kubernetes or any orchestrator,
#   * it does not touch Caddy,
#   * it does not touch the `pm2 startup` service,
#   * it does not restart, rename or delete any PM2 process other than flex-api,
#   * it does NOT run `pm2 save` — that is a deliberate, separate, verified step
#     (see the printed instructions) because `pm2 save` snapshots EVERY process,
#     including any temporary ones.
#
# Usage:
#   FLEX_REPO=/home/ubuntu/flex bash vps-deploy.sh
#
set -euo pipefail

FLEX_REPO="${FLEX_REPO:-$PWD}"
FLEX_BOTS_ROOT="${FLEX_BOTS_ROOT:-/opt/flex-bots}"
PM2="${PM2:-$(command -v pm2 || true)}"

say() { printf '\n== %s\n' "$1"; }
die() { printf '\n!! %s\n' "$1" >&2; exit 1; }

[ -d "$FLEX_REPO/artifacts/ddbot-app" ] || die "FLEX_REPO does not look like the flex monorepo: $FLEX_REPO"
[ -n "$PM2" ] || die "pm2 not found on PATH"
command -v pnpm >/dev/null 2>&1 || die "pnpm is required: the workspace pins pnpm@10.26.1. Install with corepack enable && corepack prepare pnpm@10.26.1 --activate"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node >= 22 is required (found $(node --version)): the headless runtime uses the global WebSocket."

say "1/6  install workspace dependencies (pnpm install --frozen-lockfile)"
( cd "$FLEX_REPO" && pnpm install --frozen-lockfile )
say "2/6  build the shared headless runtime (jsdom and ws are inlined)"
( cd "$FLEX_REPO" && pnpm --filter @workspace/ddbot-app run build:bot-runtime )
RUNTIME_BUNDLE="$FLEX_REPO/artifacts/ddbot-app/dist-headless/bot-runtime.mjs"
RUNTIME_WORKER="$FLEX_REPO/artifacts/ddbot-app/dist-headless/xhr-sync-worker.js"
[ -f "$RUNTIME_WORKER" ] || die "xhr-sync-worker.js was not produced - rebuild with the current build-headless.mjs"
[ -f "$RUNTIME_BUNDLE" ] || die "runtime bundle was not produced at $RUNTIME_BUNDLE"

say "3/6  install $FLEX_BOTS_ROOT/runtime (shared bundle + jsdom sync-XHR asset)"
install -d -m 750 "$FLEX_BOTS_ROOT" "$FLEX_BOTS_ROOT/runtime"
install -m 640 "$RUNTIME_BUNDLE" "$FLEX_BOTS_ROOT/runtime/bot-runtime.mjs"
install -m 640 "$RUNTIME_WORKER" "$FLEX_BOTS_ROOT/runtime/xhr-sync-worker.js"
# No node_modules exists in that directory: an external jsdom reference means every
# bot process would die on ERR_MODULE_NOT_FOUND before it ever authenticated.
if grep -q jsdom "$FLEX_BOTS_ROOT/runtime/bot-runtime.mjs"; then
  die "installed runtime references jsdom externally - rebuild with the inlined-jsdom build"
fi
ls -la "$FLEX_BOTS_ROOT" "$FLEX_BOTS_ROOT/runtime"

say "4/6  build the API server"
( cd "$FLEX_REPO" && pnpm --filter @workspace/api-server run build )

say "5/6  restart ONLY flex-api"
if "$PM2" describe flex-api >/dev/null 2>&1; then
  "$PM2" restart flex-api --update-env
  "$PM2" describe flex-api | grep -E 'status|exec cwd' | sed 's/^/  /'
else
  echo "  (flex-api is not managed by pm2 here — start it as it was started before)"
fi

say "6/6  required API environment variables"
cat <<'ENV'
  Add these to the api-server environment (never commit them):

    FLEX_BOTS_ROOT=/opt/flex-bots
    FLEX_BOTS_MAX=3
    FLEX_BOTS_PM2_SAVE=0            # set to 1 only after the runbook verifies the list
    PM2_BIN=/usr/local/bin/pm2      # absolute path; run `command -v pm2` to confirm
    VITE_DERIV_APP_ID=<existing app id>
    SESSION_SECRET=<existing secret>
    API_BASE_URL=<existing backend URL>
    FRONTEND_URL=<existing frontend URL>
    ALLOWED_ORIGINS=<existing frontend origin>
ENV

cat <<'NEXT'

NEXT STEPS — all manual and verified, in this order:

  1. Confirm the API is healthy:
       curl -sS https://<backend>/api/healthz

  2. Confirm the new routes are PROTECTED (must be 401, never 200):
       curl -sS -o /dev/null -w '%{http_code}\n' https://<backend>/api/vps-bots

  3. Open https://flex-api-server.vercel.app/vps-bots and complete the
     Phase 4 acceptance tests (upload → deploy → start → live market data →
     stats → close the browser → stop → restart → reboot check).

  4. ONLY after step 3 passes:
       pm2 list                      # verify exactly the processes you want saved
       pm2 save                      # then persist them
       systemctl is-enabled pm2-$(whoami)   # the startup unit must stay enabled

  5. Never run `pm2 save` with debug or temporary processes still online.
NEXT
