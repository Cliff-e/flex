/**
 * Headless global shims for the XML/Blockly bot runtime.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bot runtime (src/external/bot-skeleton/**) is browser-first:
 *   - scratch/blockly.js mounts Blockly on the `window` global
 *   - Blockly.utils.xml parses strategy XML through the DOM
 *   - @deriv/js-interpreter is a UMD build that reads `self` at load time
 *   - browser libraries merely *imported* on the code path read DOM globals at
 *     module scope (e.g. file-saver touches HTMLAnchorElement.prototype)
 *
 * Headless execution needs only XML parsing, code generation and the JS
 * interpreter, so this module installs the minimum global surface that those
 * code paths touch. It is purely additive: no existing file is modified.
 */
import { JSDOM } from 'jsdom';

type AnyGlobal = Record<string, unknown>;

let installed = false;

/** Installs the shims exactly once. Safe to call repeatedly. */
export function installHeadlessShims(): void {
    if (installed) return;
    installed = true;

    const g = globalThis as unknown as AnyGlobal;

    // 1. `self` - @deriv/js-interpreter's UMD wrapper resolves its global via `self`.
    if (g.self === undefined) g.self = g;

    // 2. jsdom. A DOM is required for Blockly XML parsing and by browser-only
    //    helpers that are imported (not called) on the code path.
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost/' });
    const win = dom.window as unknown as AnyGlobal;

    // Expose the jsdom window surface, but NEVER over an existing Node global:
    // Node's own timers/fetch/performance/URL/crypto keep priority.
    for (const key of Object.getOwnPropertyNames(win)) {
        if (key === 'window' || key === 'self' || key === 'globalThis' || key === 'global') continue;
        if (g[key] !== undefined) continue;
        try {
            g[key] = win[key];
        } catch {
            // Some jsdom window accessors throw outside a browsing context.
            // None of them are needed headlessly.
        }
    }
    // Inherited browser APIs that the headless runtime path calls, but which are
    // NOT own properties of the jsdom window instance - so the loop above misses
    // them. Each one is BOUND to the jsdom window: jsdom's implementations check
    // internal slots, so an unbound reference would throw "Illegal invocation"
    // when called with globalThis as the receiver.
    //
    //   - api_base._attachWsEvents()/_detachWsEvents() call
    //     window.addEventListener('online'|'focus') / removeEventListener.
    //     Those are browser-only events; headlessly they simply never fire.
    //   - network_monitor.js reads navigator.onLine.
    //   - @/components/shared/utils/routes reads window.location.hostname at
    //     module scope, so `location` must exist before that module is evaluated.
    const INHERITED_BROWSER_APIS = [
        'addEventListener',
        'removeEventListener',
        'dispatchEvent',
        'getComputedStyle',
        'matchMedia',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'navigator',
        'location',
        'history',
        'document',
        'screen',
    ] as const;

    for (const key of INHERITED_BROWSER_APIS) {
        if (g[key] !== undefined) continue;
        try {
            const value = win[key];
            g[key] = typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(win) : value;
        } catch {
            // Accessors that require a browsing context; none are needed headlessly.
        }
    }



    // 3. UI-only globals the runtime references but must never need headlessly.
    if (g.alert === undefined) g.alert = () => undefined;
    if (g.prompt === undefined) g.prompt = () => null;
    if (g.confirm === undefined) g.confirm = () => false;

    // 4. `window` - every custom Blockly block addresses `window.Blockly.*`.
    //    Node's globalThis IS our window, so `window.Blockly` and the bare
    //    `Blockly` global (read by scratch/hooks/colours.js) are one object.
    if (g.window === undefined) g.window = g;
}

/** True once installHeadlessShims() has run - assertion helper for tests. */
export function shimsInstalled(): boolean {
    return installed;
}
