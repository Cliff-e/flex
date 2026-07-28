import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * get_exit_digit_list — value block
 *
 * Returns the global exit-digit history as a list (up to 25 entries).
 * Index 0 = oldest entry, last index = most recent.
 * Populated automatically on every trade settlement — no "Store exit digit" block needed.
 */
window.Blockly.Blocks.get_exit_digit_list = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Exit digit history'),
            output: null,
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: localize(
                'Returns the global exit digit history as a list (up to 25 digits). ' +
                'Updated automatically after every settled trade — first item is oldest, last is most recent.'
            ),
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Exit digit history'),
            description: localize(
                'Returns the rolling global history of exit digits as a list. ' +
                'Recorded automatically — no "Store exit digit" block required.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.get_exit_digit_list = () => {
    const code = 'Bot.getExitDigitList()';
    return [code, window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
