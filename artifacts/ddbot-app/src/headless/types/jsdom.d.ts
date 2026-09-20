/**
 * Minimal ambient types for jsdom.
 *
 * jsdom ships no bundled declarations and @types/jsdom is not a dependency of
 * this workspace. Only the surface used by src/headless/shim.ts is declared.
 */
declare module 'jsdom' {
    export class JSDOM {
        constructor(html?: string, options?: { url?: string; [key: string]: unknown });
        readonly window: {
            document: unknown;
            DOMParser: unknown;
            XMLSerializer: unknown;
            Node: unknown;
            navigator: unknown;
            localStorage: unknown;
            location: unknown;
        };
    }
}
