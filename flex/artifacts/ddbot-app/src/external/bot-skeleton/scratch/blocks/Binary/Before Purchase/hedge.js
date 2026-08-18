import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Hedge block
 *
 * Exposes a Blockly interface for hedge execution within the Purchase
 * Conditions section.  The runtime delegates to Bot.hedge() which can be
 * wired to any hedge implementation without touching this block.
 *
 * No duplicate purchase engine is introduced — existing execution
 * infrastructure is reused.
 */

window.Blockly.Blocks.hedge = {
    init() {
        this.jsonInit(this.definition());

        // Terminal — a hedge action is a leaf in the purchase branch.
        this.setNextStatement(false);
    },
    definition() {
        return {
            message0: localize('Hedge'),
            previousStatement: null,
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            tooltip: localize('Prepares and executes a hedge trade. Can only be used within the Purchase conditions block.'),
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Hedge'),
            description: localize(
                'Use this block to execute a hedge trade. You may add multiple Purchase blocks together with conditional blocks to define your purchase conditions. This block can only be used within the Purchase conditions block.'
            ),
            key_words: localize('hedge, buy, opposite'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
    restricted_parents: ['before_purchase'],
};

// Delegate to Bot.hedge() — wired at runtime to the existing execution infra.
window.Blockly.JavaScript.javascriptGenerator.forBlock.hedge = () => {
    return `Bot.hedge();\n`;
};
