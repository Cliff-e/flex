import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * get_exit_digit_list — value block
 *
 * Returns the full rolling exit-digit buffer as a list.
 * Index 0 = oldest entry, last index = most recent.
 */
window.Blockly.Blocks.get_exit_digit_list = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Exit digit list'),
            output: null,
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: localize(
                'Returns all stored exit digits as a list. ' +
                'The first item is the oldest digit; the last item is the most recent.'
            ),
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Exit digit list'),
            description: localize('Returns the rolling buffer of stored exit digits as a list.'),
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
