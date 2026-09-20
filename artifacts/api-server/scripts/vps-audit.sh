#!/usr/bin/env bash
#
# Phase 4 — READ-ONLY VPS audit.
#
# Run this on the EC2 host BEFORE any change. It prints only what is needed to
# confirm the architecture, and it is safe to paste into a ticket:
#
#   * it runs no mutating command,
#   * it never prints the CONTENTS of any .env file — only the KEY NAMES,
#   * it never prints a token, a secret, or an SSH key,
#   * it never prints a private key path's contents,
#     and it never prints PM2 environment variables (they may contain secrets).
# Strictly read-only: no mkdir/touch/rm/cp/mv/chmod/chown/install, no git
# pull/fetch, no pm2 restart/save/start/stop/delete, no systemctl mutation, no
# sudo; a missing item is reported as NOT PRESENT or NOT AVAILABLE, never guessed.
#
# Usage:  bash vps-audit.sh
#
set -uo pipefail

hr() { printf '\n=== %s ===\n' "$1"; }

hr "identity"
echo "whoami : $(whoami)"
echo "host   : $(hostname)"
echo "kernel : $(uname -srm)"

hr "os release"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  grep -E '^(NAME|VERSION)=' /etc/os-release | sed 's/^/  /'
fi

hr "node / npm / pm2"
echo "node : $(command -v node || echo '(absent)') $(node --version 2>/dev/null || echo '')"
echo "npm  : $(command -v npm  || echo '(absent)') $(npm  --version 2>/dev/null || echo '')"
echo "pm2  : $(command -v pm2  || echo '(absent)') $(pm2  --version 2>/dev/null || echo '')"

hr "pm2 process list"
pm2 jlist 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s);for(const a of p){console.log([a.name,a.pm2_env&&a.pm2_env.status,a.pid,a.pm2_env&&a.pm2_env.pm_cwd].join(" | "));}}catch(e){console.log("(pm2 jlist unavailable)");}})' \
  || echo "(pm2 jlist unavailable)"

hr "pm2 startup service"
systemctl is-enabled "pm2-$(whoami)" 2>/dev/null || echo "(pm2 startup unit not found for this user)"
systemctl is-active  "pm2-$(whoami)" 2>/dev/null || true

hr "flex-api working directory (from pm2, no env values)"
pm2 describe flex-api 2>/dev/null | grep -E 'script path|script args|exec cwd|status|node v' | sed 's/^/  /' || echo "(flex-api not managed by pm2)"

hr "pm2 log paths (flex-api)"
pm2 describe flex-api 2>/dev/null | grep -E 'out log|error log' | sed 's/^/  /' || true

hr "repository layout"
for p in /home/*/*/flex /opt/*/flex /var/www/*/flex; do
  [ -d "$p" ] && echo "repo: $p"
done

hr "deployed git commit"
REPO="${FLEX_REPO:-}"
if [ -n "$REPO" ] && [ -d "$REPO/.git" ]; then
  git -C "$REPO" --no-pager log -1 --format='  %H %s' 2>/dev/null || true
  git -C "$REPO" status --short 2>/dev/null | head -20
else
  echo "(set FLEX_REPO=/path/to/repo to include this)"
fi

hr "node_modules present?"
if [ -n "$REPO" ]; then
  for sub in artifacts/api-server artifacts/ddbot-app; do
    [ -d "$REPO/$sub/node_modules" ] && echo "  present: $sub/node_modules" || echo "  MISSING: $sub/node_modules"
  done
fi

hr ".env KEY NAMES ONLY (values withheld)"
if [ -n "$REPO" ]; then
  for f in "$REPO"/artifacts/api-server/.env "$REPO"/.env; do
    if [ -r "$f" ]; then
      echo "  file: $f"
      grep -vE '^[[:space:]]*(#|$)' "$f" | cut -s -d= -f1 | sed 's/^/    key: /'
    fi
  done
else
  echo "(set FLEX_REPO=/path/to/repo to include this)"
fi

hr "disk"
df -h / /var 2>/dev/null | sed 's/^/  /'

hr "memory"
free -m | sed 's/^/  /'

hr "caddy"
echo "binary : $(command -v caddy || echo '(absent)')"
echo "config : $(ls -1 /etc/caddy/Caddyfile 2>/dev/null || echo '(none)')"
systemctl is-active caddy 2>/dev/null || true

hr "listening ports"
(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | head -25 | sed 's/^/  /'

hr "node websocket capability"
node -e 'console.log("  global WebSocket:", typeof WebSocket)' 2>/dev/null || echo "  (node unavailable)"
node -e 'console.log("  global fetch    :", typeof fetch)' 2>/dev/null || true

hr "/opt/flex-bots"
if [ -d /opt/flex-bots ]; then
  ls -la /opt/flex-bots | sed 's/^/  /'
else
  echo "  (absent — expected before the first Phase 4 deploy)"
fi

hr "PART 1 complete"
echo "Nothing above was modified."

hr "PART 2 - resources, toolchain, runtime and egress (read-only, no env values)"
hr "cpu"
echo "  nproc : $(nproc 2>/dev/null || echo NOT-AVAILABLE)"
echo "  model : $(grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed "s/^ //")"
echo "  load  : $(cat /proc/loadavg 2>/dev/null || echo NOT-AVAILABLE)"
grep -E "^(SwapTotal|SwapFree):" /proc/meminfo 2>/dev/null | sed "s/^/  /" || echo "  swap: NOT AVAILABLE"
hr "top memory consumers (comm only - no cmdline, no environment)"
ps -eo rss,comm --sort=-rss 2>/dev/null | head -8 | sed "s/^/  /" || echo "  NOT AVAILABLE"
hr "toolchain (deploy prerequisites)"
echo "  pnpm  : $(pnpm --version 2>/dev/null || echo NOT-INSTALLED-REQUIRED-FOR-DEPLOY-BUILD)"
echo "  pkgmgr: $(grep -m1 packageManager $REPO/package.json 2>/dev/null || echo NOT-AVAILABLE)"
hr "build prerequisites (the deploy build needs these)"
echo "  api-server node_modules : $([ -d $REPO/artifacts/api-server/node_modules ] && echo present || echo MISSING)"
echo "  ddbot-app node_modules  : $([ -d $REPO/artifacts/ddbot-app/node_modules ] && echo present || echo MISSING)"
echo "  ddbot-app esbuild       : $([ -d $REPO/artifacts/ddbot-app/node_modules/esbuild ] && echo present || echo MISSING-RUN-PNPM-INSTALL)"
echo "  ddbot-app jsdom         : $([ -d $REPO/artifacts/ddbot-app/node_modules/jsdom ] && echo present || echo MISSING-RUN-PNPM-INSTALL)"
hr "pm2 process detail (status, restarts, memory - pm2 list never prints env)"
pm2 list --no-color 2>/dev/null || echo "  NOT AVAILABLE (pm2 list failed or no processes)"
hr "/opt/flex-bots/runtime (shared runtime bundle)"
if [ -d /opt/flex-bots/runtime ]; then
  ls -la /opt/flex-bots/runtime | sed "s/^/  /"
  if [ -r /opt/flex-bots/runtime/bot-runtime.mjs ]; then
    echo "  bot-runtime.mjs bytes: $(wc -c < /opt/flex-bots/runtime/bot-runtime.mjs 2>/dev/null)"
    grep -q jsdom /opt/flex-bots/runtime/bot-runtime.mjs && echo "  WARNING: external jsdom reference - bundle needs node_modules" || echo "  self-contained: no external jsdom reference"
    [ -f /opt/flex-bots/runtime/xhr-sync-worker.js ] && echo "  xhr-sync-worker.js: present (jsdom resolves this path at load)" || echo "  xhr-sync-worker.js: NOT PRESENT - jsdom cannot load"
  else
    echo "  bot-runtime.mjs: NOT PRESENT"
  fi
  [ -d /opt/flex-bots/runtime/node_modules ] && echo "  runtime/node_modules: PRESENT (unexpected)" || echo "  runtime/node_modules: NOT PRESENT (correct)"
else
  echo "  NOT PRESENT (expected before the first Phase 4 deploy)"
fi
hr "per-bot dependency hygiene (expected: zero per-bot node_modules)"
echo "  bot directories      : $(ls -d /opt/flex-bots/bot-* 2>/dev/null | wc -l)"
echo "  per-bot node_modules : $(find /opt/flex-bots -maxdepth 2 -type d -name node_modules 2>/dev/null | wc -l)"
hr "egress to Deriv (UNAUTHENTICATED: DNS and status code only - no credentials, no market data)"
for h in api.derivws.com auth.deriv.com; do
  echo "  $h dns: $(getent hosts $h 2>/dev/null | head -1 | sed "s/ .*//" || echo NOT-AVAILABLE) https: $(curl -sS -m 8 -o /dev/null -w %{http_code} https://$h/ 2>/dev/null || echo NOT-AVAILABLE)"
done
hr "audit complete"
echo "PART 1 and PART 2 ran no mutating command; nothing was modified, and no env value, token or key was printed."
