import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * get_exit_digit_count — value block
 *
 * Returns how many digits are currently stored in the global rolling history
 * (0 – 25).
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
                'Returns the number of exit digits currently in the rolling history (0 – 25). ' +
                'Useful for guarding blocks that need a minimum sample size.'
            ),
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Exit digit count'),
            description: localize('Returns how many exit digits are stored in the rolling history.'),
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
