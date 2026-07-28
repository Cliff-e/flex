import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * get_exit_digit_at — value block
 *
 * Returns a single digit from the rolling buffer by position.
 * Position 1 = most recent, 2 = second most recent, etc.
 */
window.Blockly.Blocks.get_exit_digit_at = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Exit digit at position {{ pos }} (1 = latest)', { pos: '%1' }),
            args0: [
                {
                    type: 'field_number',
                    name: 'POSITION',
                    value: 1,
                    min: 1,
                    max: 500,
                    precision: 1,
                },
            ],
            output: null,
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: localize(
                'Returns the exit digit at the given position from the rolling buffer. ' +
                'Position 1 is the most recent digit, 2 is the one before that, and so on.'
            ),
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Exit digit at position'),
            description: localize(
                'Reads a specific digit from the rolling buffer. ' +
                'Position 1 returns the latest stored exit digit.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.get_exit_digit_at = block => {
    const position = block.getFieldValue('POSITION') || 1;
    const code = `Bot.getExitDigitAt(${position})`;
    return [code, window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
