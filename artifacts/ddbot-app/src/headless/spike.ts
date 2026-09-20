/**
 * PHASE 0 GATE - proof that the existing XML/Blockly runtime generates code
 * headlessly under Node: no browser, no editor, no user session.
 *
 * For every strategy in src/xml it asserts three things, not just "output
 * happened":
 *   1. code generation succeeds
 *   2. field values survived XML -> workspace (the strategy symbol appears in the
 *      generated code), which is what silently degrades when dropdown options are
 *      not loaded
 *   3. the generated source parses in @deriv/js-interpreter - the exact runtime
 *      that will execute it on the VPS
 *
 * Usage: node dist-headless/spike.mjs [strategiesDir]
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootHeadlessRuntime } from './blocklyHeadless';

/** Stand-in credential - the real token is injected from the bot credential store. */
const DUMMY_TOKEN = 'PHASE0_DUMMY_TOKEN';

/** Reads the symbol the generated code will trade. */
function extractSymbol(code: string): string {
    const match = /symbol\s*:\s*'([^']*)'/.exec(code);
    return match ? match[1] : '';
}

async function main(): Promise<void> {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '../src/xml');
    const files = readdirSync(dir).filter(name => name.endsWith('.xml')).sort();

    console.log(`[phase0] strategies: ${dir} (${files.length} files)`);
    const runtime = await bootHeadlessRuntime();
    runtime.setAccountContext({
        currency: 'USD',
        loginid: 'VRTC000000',
        accessToken: DUMMY_TOKEN,
    });

    const interpreterModule = (await import('@deriv/js-interpreter')) as unknown as {
        default: new (code: string) => unknown;
    };
    const JSInterpreter = interpreterModule.default;

    let generated = 0;
    let parsed = 0;
    let withSymbol = 0;
    const failures: string[] = [];

    for (const name of files) {
        const xml = readFileSync(path.join(dir, name), 'utf8');
        try {
            const code = runtime.xmlToCode(xml);
            if (!code || code.length < 200) {
                throw new Error(`output too short (${code ? code.length : 0} chars)`);
            }
            generated += 1;

            // 2. field values must survive: dropdown options are NOT loaded headlessly,
            //    so a dropped value would silently produce a bot trading nothing.
            const symbol = extractSymbol(code);
            if (!symbol) throw new Error('strategy symbol missing from generated code');
            withSymbol += 1;

            // 3. the credential must be threaded through client.getToken()
            if (!code.includes(DUMMY_TOKEN)) {
                throw new Error('account token not threaded into generated code');
            }

            // 4. parse with the exact interpreter that will run it
            new JSInterpreter(code);
            parsed += 1;

            console.log(`PASS  ${name} -> ${code.length} chars | symbol='${symbol}' | interpreter: parsed`);
        } catch (error) {
            failures.push(`${name}: ${(error as Error).message}`);
            console.log(`FAIL  ${name} -> ${(error as Error).message}`);
            if (failures.length === 1) console.log('[phase0] first failure stack:\n' + (error as Error).stack);
        }
    }

    console.log(`\n[phase0] code generated     : ${generated}/${files.length}`);
    console.log(`[phase0] symbol preserved   : ${withSymbol}/${files.length}`);
    console.log(`[phase0] interpreter parsed : ${parsed}/${files.length}`);

    if (failures.length > 0) {
        console.log(`[phase0] failures:\n${failures.join('\n')}`);
        process.exitCode = 1;
    }
}

void main();
