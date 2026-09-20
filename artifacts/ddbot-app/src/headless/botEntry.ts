/**
 * Entry point for one PM2-supervised bot process.
 *
 * This is deliberately a separate module from `runtime.ts`:
 *   - the bundle entry MUST start the bot as a side effect (PM2 just runs it),
 *   - the Phase 1 verification harness MUST be able to import the runtime
 *     without accidentally starting a bot.
 *
 * IMPORT ORDER MATTERS. The existing runtime graph (trade engine, api_base,
 * @/components/shared) reads DOM globals such as `window.location` at module
 * scope, so the headless shims must exist BEFORE those modules are evaluated.
 * `shim.ts` is imported statically (it only needs jsdom) and installed first;
 * `runtime.ts` - the module that pulls in the whole graph - is then loaded
 * dynamically. This is the same boot order the Phase 0 spike proved.
 *
 * Everything the process needs is configured through the environment
 * (`BOT_ID`, `BOT_DIR`, `DERIV_APP_ID`, `BOT_CREDENTIAL_FILE`,
 * `BOT_CONNECT_TIMEOUT_MS`); PM2 passes them per bot process.
 */
import { installHeadlessShims } from './shim';

installHeadlessShims();

void (async () => {
    const { main } = await import('./runtime');
    const code = await main();

    if (code !== 0) {
        // A terminal state (expired / error / misconfiguration) is reported with
        // a distinct non-zero code so PM2's restart handling and the operator both
        // see an honest failure instead of a healthy-looking idle process.
        process.exit(code);
    }
    // Authenticated: the interpreter loop and the open Deriv socket keep the
    // process alive. SIGTERM/SIGINT (see `attachSignalHandlers`) ends it.
    process.exitCode = 0;
})();
