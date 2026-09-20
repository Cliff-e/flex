/**
 * Phase 2 gate runner.
 *
 * Bundles `src/verify/phase2.ts` with the same esbuild settings the production
 * build uses (platform node, ESM, the `createRequire` banner CJS dependencies
 * need) and runs it. Keeping the harness bundled means it exercises the real
 * modules, with no ts-node/loader indirection that could behave differently.
 *
 * Usage: node scripts/verify-phase2.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { build as esbuild } from "esbuild";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.resolve(artifactDir, "dist-verify");
const outfile = path.join(outDir, "phase2.mjs");

await rm(outDir, { recursive: true, force: true });

console.log("[verify-phase2] bundling src/verify/phase2.ts");

await esbuild({
  entryPoints: [path.resolve(artifactDir, "src/verify/phase2.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outfile,
  sourcemap: "inline",
  logLevel: "warning",
  banner: {
    js: `import { createRequire as __v2CrReq } from 'node:module';
globalThis.require = __v2CrReq(import.meta.url);`,
  },
});

console.log(`[verify-phase2] running ${path.relative(artifactDir, outfile)}`);

const result = spawnSync(process.execPath, [outfile], { stdio: "inherit", cwd: artifactDir });
process.exit(result.status ?? 1);
