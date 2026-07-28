import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * get_exit_digit_count — value block
 *
 * Returns the number of digits currently stored in the global exit-digit history.
 * Useful for guarding strategy logic until enough history has accumulated.
 */
window.Blockly.Blocks.get_exit_digit_count = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Exit digit count'),
            output: null,
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: localize(
                'Returns the number of exit digits currently stored in the global history (0–25). ' +
                'Use this to wait until enough history has built up before applying a strategy.'
            ),
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Exit digit count'),
            description: localize(
                'Returns how many digits are in the global exit digit history. ' +
                'Maximum is 25; the oldest digit is dropped automatically once the buffer is full.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.get_exit_digit_count = () => {
    const code = 'Bot.getExitDigitCount()';
    return [code, window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
