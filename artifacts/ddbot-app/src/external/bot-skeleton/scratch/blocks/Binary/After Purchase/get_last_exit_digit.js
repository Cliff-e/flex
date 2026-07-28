import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * get_last_exit_digit — value block
 *
 * Returns the most recent digit from the global exit-digit history service.
 * This is a convenience shortcut for "Exit digit at position 1".
 */
window.Blockly.Blocks.get_last_exit_digit = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Last exit digit'),
            output: null,
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: localize(
                'Returns the last digit (0–9) of the most recently settled contract. ' +
                'Reads from the global exit digit history — no "Store exit digit" block needed.'
            ),
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Last exit digit'),
            description: localize(
                'Returns the exit digit of the most recently completed trade ' +
                'from the automatic global history.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.get_last_exit_digit = () => {
    const code = 'Bot.getLastExitDigit()';
    return [code, window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
