# DDBot (CKK Edge)

A Deriv trading bot application cloned from https://github.com/Cliff-e/flex. Provides a visual bot builder, quick-strategy wizard, live charts, and automated trading via the Deriv WebSocket API.

## Run & Operate

- `pnpm --filter @workspace/ddbot-app run dev` — run the DDBot frontend (port 23030, via workflow `artifacts/ddbot-app: web`)
- `pnpm --filter @workspace/api-server run dev` — run the Express API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- **DDBot frontend**: React 18, rsbuild, MobX, Blockly, `@deriv/deriv-charts`
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle) for API; rsbuild for DDBot frontend

## Where things live

- `artifacts/ddbot-app/` — DDBot React frontend (rsbuild, port 23030, preview path `/`)
- `artifacts/ddbot-app/src/app/` — App root, auth wrapper, store provider
- `artifacts/ddbot-app/src/bot/` — Bot engine, trading engine, global tick engine
- `artifacts/ddbot-app/src/external/bot-skeleton/` — Blockly-based bot builder core
- `artifacts/ddbot-app/rsbuild.config.ts` — Build config (rsbuild, SASS, aliased imports)
- `artifacts/api-server/` — Express API server (preview path `/api`)
- `lib/api-spec/openapi.yaml` — OpenAPI source of truth
- `lib/db/src/schema/` — Drizzle ORM schema

## Architecture decisions

- DDBot uses **rsbuild** (not Vite) — do not change to Vite; rsbuild is required for the SASS + raw-loader + rspack pipeline the Deriv charts depend on.
- React 18.3.1 is pinned in ddbot-app (workspace catalog uses React 19) — rsbuild aliases enforce this to avoid multi-React issues with `@deriv-com/auth-client`.
- `@deriv/deriv-charts` assets are copied via rsbuild output.copy into `dist/js/smartcharts/` and `dist/assets/`.
- Production `publicDir` is `artifacts/ddbot-app/dist` (rsbuild default) — not `dist/public`.

## Product

DDBot lets traders build, test, and run automated trading bots on Deriv without coding. Features: drag-and-drop Blockly bot builder, quick-strategy templates (Martingale, D'Alembert, etc.), live trading charts, run/stop controls, and a transaction journal.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **rsbuild only**: The `dev` script uses `./node_modules/.bin/rsbuild dev`. Do not switch to `vite` — the webpack/rspack rules (raw-loader for XML, SASS) won't work.
- Peer dep warnings for `chai`, `sinon`, `semantic-release` are expected and harmless — they come from `@deriv/deriv-charts` dev deps.
- `@parcel/watcher`, `core-js` build scripts are ignored by pnpm — this is intentional and safe.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
