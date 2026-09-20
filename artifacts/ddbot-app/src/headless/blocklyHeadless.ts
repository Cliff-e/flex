/**
 * Headless Blockly bootstrap: strategy XML -> executable JavaScript, no browser.
 *
 * This deliberately reuses the SAME modules the editor uses so the generated
 * code is identical to the browser path:
 *   - scratch/hooks/** (the full set) supplies the Blockly prototypes the block
 *     definitions and code generators call: block.js provides getChildByType()/
 *     childValueToCode(), field.js lets a FieldDropdown accept an XML value whose
 *     options are not loaded yet, constant.js publishes Blockly.Categories and
 *     OUTPUT_SHAPE_* which blocks read at import time (line 5 of that module)
 *   - scratch/blocks/index.js registers every block definition + code generator
 *   - scratch/dbot.js#generateCode() builds the final interpreter source
 *
 * Renderer hooks are imported too, because that is what the editor does and the
 * import itself is inert: they patch BlockSvg/WorkspaceSvg prototypes, which a
 * headless Blockly.Workspace never instantiates. The few renderer entry points a
 * block definition calls from updateShape() are neutralised below.
 *
 * NOTE: every dynamic import below uses a string literal on purpose - a computed
 * specifier would not be statically analysable by esbuild and would therefore
 * not be bundled.
 */
import { installHeadlessShims } from './shim';

type AnyRecord = Record<string, any>;

export type HeadlessAccountContext = {
    currency?: string;
    loginid?: string;
    /** Deriv access token. The trade_definition generator embeds this value in
     *  the generated code (Bot.init('<token>')), so it must never be logged,
     *  persisted, or returned by the runtime. */
    accessToken?: string;
    landingCompanyShortcode?: string;
};

export type HeadlessRuntime = {
    setAccountContext: (context: HeadlessAccountContext) => void;
    xmlToCode: (xml: string, limitations?: Record<string, unknown>) => string;
};

let bootPromise: Promise<HeadlessRuntime> | null = null;

async function boot(): Promise<HeadlessRuntime> {
    installHeadlessShims();
    const g = globalThis as unknown as AnyRecord;

    // --- 1. Blockly core + JavaScript generator (mirrors scratch/blockly.js) ---
    const BlocklyModule = (await import('blockly')) as unknown as AnyRecord;
    const Blockly = BlocklyModule.default as AnyRecord;
    g.Blockly = Blockly;
    Blockly.Colours = {};

    const BlocklyJavaScript = (await import('blockly/javascript')) as unknown as AnyRecord;
    Blockly.JavaScript = { ...BlocklyJavaScript, ...new Blockly.Generator('code') };
    Blockly.Themes.zelos_renderer = Blockly.Theme.defineTheme('zelos_renderer', {
        base: Blockly.Themes.Zelos,
        componentStyles: {},
    });

    // --- 2. Hooks ---
    const { setColors } = (await import(
        '../external/bot-skeleton/scratch/hooks/colours.js'
    )) as unknown as AnyRecord;
    setColors();
    await import('../external/bot-skeleton/scratch/hooks/index.js');

    // --- 3. Block definitions + code generators ---
    await import('../external/bot-skeleton/scratch/blocks/index.js');

    // A headless Blockly.Workspace yields plain Blockly.Block instances, which have
    // no renderer. Block definitions call renderer entry points from updateShape()
    // (and backward-compatibility.js calls renderEfficiently()); in the editor
    // those are BlockSvg methods. Headlessly they are no-ops: only the block graph
    // matters, never its paint.
    for (const renderMethod of ['initSvg', 'render', 'queueRender', 'bumpNeighbours', 'renderEfficiently']) {
        if (typeof Blockly.Block.prototype[renderMethod] !== 'function') {
            Blockly.Block.prototype[renderMethod] = () => undefined;
        }
    }

    // The editor attaches onchange handlers to most block definitions to keep the
    // GUI consistent (field option refresh, validation highlighting). They assume a
    // rendered workspace - isDragging()/isFlyoutVisible exist only on BlockSvg - and
    // never influence code generation, so the headless registry drops them.
    const blockDefinitions = Blockly.Blocks as Record<string, { onchange?: unknown }>;
    for (const type of Object.keys(blockDefinitions)) {
        const definition = blockDefinitions[type];
        if (definition) delete definition.onchange;
    }

    // --- 4. Headless DBotStore ---
    // The code generators and the workspace hooks read DBotStore.instance from
    // inside their bodies (client.currency, client.getToken(loginid),
    // setContractUpdateConfig(), toolbar.setHasRedoStack()), so a store instance
    // must exist. setInstance() is the store own injection point - scratch/
    // dbot-store.js - and is exactly what the React app already calls.
    const { default: DBotStore } = (await import(
        '../external/bot-skeleton/scratch/dbot-store.js'
    )) as unknown as AnyRecord;

    // Mutable so the caller can supply real credentials after boot; a plain object
    // is deliberate - MobX reactions cannot track it, so mutating these fields
    // never triggers the store loginid reaction into api_base.createNewInstance().
    const credentials: HeadlessAccountContext = {
        currency: 'USD',
        loginid: '',
        accessToken: '',
        landingCompanyShortcode: 'virtual',
    };

    const client = {
        is_logged_in: true,
        is_virtual: true,
        get currency() {
            return credentials.currency ?? 'USD';
        },
        get loginid() {
            return credentials.loginid ?? '';
        },
        get landing_company_shortcode() {
            return credentials.landingCompanyShortcode ?? 'virtual';
        },
        // client-store.ts implements this as () => accessToken.
        getToken: () => credentials.accessToken ?? '',
    };

    DBotStore.setInstance({
        is_mobile: false,
        is_dark_mode_on: false,
        client,
        dashboard: { setBotBuilderSymbol: () => undefined },
        flyout: {},
        toolbar: { setHasRedoStack: () => undefined, setHasUndoStack: () => undefined },
        toolbox: {},
        save_modal: {},
        load_modal: {},
        setContractUpdateConfig: () => undefined,
        toggleStrategyModal: () => undefined,
        handleFileChange: () => undefined,
        setLoading: () => undefined,
    });

    // Some runtime helpers read window.DBotStore directly.
    g.DBotStore = DBotStore;

    // --- 5. A headless workspace, wired the same way the editor wires it ---
    const workspace = new Blockly.Workspace();
    Blockly.derivWorkspace = workspace;
    if (Blockly.common && typeof Blockly.common.setMainWorkspace === 'function') {
        Blockly.common.setMainWorkspace(workspace);
    }

    // The procedure generators read Blockly.JavaScript.variableDB_. dbot.js only
    // creates it inside initWorkspace(), together with the editor mount - but code
    // generation needs the same wiring, so it is replicated here.
    const variableDB = new Blockly.Names('window');
    if (typeof variableDB.setVariableMap === 'function') {
        variableDB.setVariableMap(workspace.getVariableMap());
    }
    variableDB.variableMap = workspace.getVariableMap();
    Blockly.JavaScript.variableDB_ = variableDB;

    // Reuse the editor own code generator - no template is duplicated here.
    const { default: DBot } = (await import('../external/bot-skeleton/scratch/dbot.js')) as unknown as AnyRecord;
    DBot.workspace = workspace;

    return {
        setAccountContext: (context: HeadlessAccountContext) => {
            Object.assign(credentials, context);
        },
        xmlToCode: (xml: string, limitations: Record<string, unknown> = {}) => {
            const dom = Blockly.utils.xml.textToDom(xml);
            workspace.clear();
            Blockly.Events.disable();
            try {
                Blockly.Xml.domToWorkspace(dom, workspace);
            } finally {
                Blockly.Events.enable();
            }
            return DBot.generateCode(limitations) as string;
        },
    };
}

/** Boots the headless runtime once; concurrent callers share the same promise. */
export function bootHeadlessRuntime(): Promise<HeadlessRuntime> {
    if (!bootPromise) bootPromise = boot();
    return bootPromise;
}
