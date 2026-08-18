import { localize } from '@deriv-com/translations';
import { excludeOptionFromContextMenu, modifyContextMenu } from '../../../utils';

/**
 * Purchase Current Contract block — smart universal purchase that reads the
 * active contract from the RuntimeContext rather than requiring a hardcoded type.
 *
 * This is the recommended purchase block for runtime-driven bots:
 *   - If a Contract Type Switcher has run, it uses that override.
 *   - Otherwise it falls back to the Trade Parameters contract type.
 *
 * Legacy purchase blocks (Purchase, Purchase All Contracts) continue to work
 * unchanged — they still call Bot.purchase(type) directly.
 */

window.Blockly.Blocks.purchase_current_contract = {
    init() {
        this.jsonInit(this.definition());
        // Only one purchase block per statement stack
        this.setNextStatement(false);
    },
    definition() {
        return {
            message0: localize('Purchase Current Contract'),
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            previousStatement: null,
            tooltip: localize(
                'Purchases whatever contract is currently active in the RuntimeContext. If a Contract Type Switcher block has run, that type is used; otherwise the Trade Parameters contract is used. This replaces the need for separate Purchase Differs, Purchase Under, etc. blocks.'
            ),
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Purchase Current Contract'),
            description: localize(
                'Smart universal purchase block: automatically buys whichever contract type is currently active (set by Contract Type Switcher or Trade Parameters). Use this instead of individual purchase blocks in runtime-driven bots.'
            ),
            key_words: localize('purchase, buy, contract, current, smart, active'),
        };
    },
    customContextMenu(menu) {
        const menu_items = [localize('Enable Block'), localize('Disable Block')];
        excludeOptionFromContextMenu(menu, menu_items);
        modifyContextMenu(menu);
    },
    restricted_parents: ['before_purchase'],
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.purchase_current_contract = () => {
    // Bot.purchaseCurrentContract() delegates to the existing purchase pipeline,
    // reading activeContractOverride first, then falling back to Trade Parameters.
    return `Bot.purchaseCurrentContract();\n`;
};
