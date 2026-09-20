/**
 * Headless runtime bundler (Phase 0/1).
 *
 * Produces a self-contained Node bundle from the SAME sources the browser build
 * uses, so a VPS bot process needs no node_modules of its own.
 *
 * Usage: node build-headless.mjs [entry] [outfile]
 */
import { build } from 'esbuild';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(dir, 'src');
const outDir = path.resolve(dir, 'dist-headless');

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', ''];
const INDEX_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

const isFile = p => {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * esbuild does NOT apply extension/index resolution to paths returned by an
 * onResolve plugin, so this mirrors the Node/tsconfig resolution order.
 */
const resolveSpec = base => {
  for (const ext of EXTS) {
    const candidate = base + ext;
    if (isFile(candidate)) return candidate;
  }
  for (const ext of INDEX_EXTS) {
    const candidate = path.join(base, 'index' + ext);
    if (isFile(candidate)) return candidate;
  }
  return base;
};

const projectResolution = {
  name: 'project-resolution',
  setup(build) {
    // `@/...` - the same alias rsbuild uses for the browser build (tsconfig paths).
    build.onResolve({ filter: /^@\// }, args => {
      const query = args.path.indexOf('?');
      const spec = query < 0 ? args.path : args.path.slice(0, query);
      return { path: resolveSpec(path.resolve(srcDir, spec.slice(2))) };
    });
    // webpack-style resource queries (`?raw`, `?react`) are not valid esbuild paths.
    build.onResolve({ filter: /\?/ }, args => {
      const query = args.path.indexOf('?');
      if (query < 0) return null;
      const stripped = args.path.slice(0, query);
      const base = stripped.startsWith('.') ? path.resolve(args.resolveDir, stripped) : stripped;
      return { path: resolveSpec(base) };
    });
  },
};

const entry = process.argv[2] ?? path.resolve(srcDir, 'headless/spike.ts');
const outfile = process.argv[3] ?? path.resolve(outDir, 'spike.mjs');

await mkdir(path.dirname(outfile), { recursive: true });
console.log(`[build-headless] ${path.relative(dir, entry)} -> ${path.relative(dir, outfile)}`);

await build({
  entryPoints: [entry],
  outfile,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  bundle: true,
  sourcemap: 'inline',
  logLevel: 'info',
  resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  loader: {
    '.xml': 'text',
    '.scss': 'empty',
    '.css': 'empty',
    '.svg': 'text',
    '.png': 'dataurl',
    '.jpg': 'dataurl',
    '.jpeg': 'dataurl',
    '.gif': 'dataurl',
  },
  define: { 'import.meta.env': '{}' },
  // Headless substitution for the UI-only i18n layer. The bot-skeleton uses it for
  // block labels only; its real implementation needs a browser locale + CDN, and the
  // workspace already mocks it for jest (__mocks__/translation.mock.js).
  alias: {
    '@deriv-com/translations': path.resolve(srcDir, 'headless/stubs/translations.ts'),
  },
  plugins: [projectResolution],
  // CJS dependencies (jsdom, ws, ...) call require() dynamically. esbuild routes
  // the bare `require` identifier through its __require shim, which resolves it
  // from globalThis - so this banner restores it, the same approach
  // artifacts/api-server/build.mjs already uses.
  banner: {
    js: `import { createRequire as __bhCrReq } from 'node:module';
import __bhPath from 'node:path';
import __bhUrl from 'node:url';
globalThis.require = __bhCrReq(import.meta.url);
globalThis.__filename = __bhUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bhPath.dirname(globalThis.__filename);`,
  },
  // Only the guarded optional dependencies stay external. Everything the runtime
  // actually needs - including jsdom and ws - is inlined, so the single installed
  // file works in a directory that has no node_modules. See the external list below.
  external: ['canvas', 'bufferutil', 'utf-8-validate'],
});

console.log('[build-headless] done');



// jsdom resolves the path of its synchronous-XHR worker at module load, so that
// file must EXIST even though the headless runtime never performs a sync XHR.
// vps-deploy.sh installs it beside the bundle (still no node_modules).
const workerStub = path.join(path.dirname(outfile), 'xhr-sync-worker.js');
if (readFileSync(outfile, 'utf8').includes('xhr-sync-worker.js')) {
  writeFileSync(workerStub, '// jsdom sync-XHR worker placeholder - resolved at load, never executed headlessly.\n');
  console.log('[build-headless] emitted ' + path.basename(workerStub));
}
