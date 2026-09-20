/**
 * Minimal ambient declaration for @deriv/js-interpreter.
 *
 * The package ships only a minified UMD build with no type declarations. Only
 * the surface used by the headless runtime is declared.
 */
declare module '@deriv/js-interpreter' {
    export default class Interpreter {
        constructor(
            code: string,
            initFunc?: (interpreter: Interpreter, globalObject: Record<string, unknown>) => void
        );
        run(): boolean;
        value: unknown;
        pseudoToNative(value: unknown): unknown;
        nativeToPseudo(value: unknown): unknown;
    }
}
