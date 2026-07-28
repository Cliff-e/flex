import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * get_exit_digit_at — value block
 *
 * Returns a single digit from the global exit-digit history by position.
 * Position 1 = most recent, 2 = second most recent, etc.
 * Reads from the automatic global history — no "Store exit digit" block needed.
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
                    max: 25,
                    precision: 1,
                },
            ],
            output: null,
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: localize(
                'Returns the exit digit at the given position from the global history. ' +
                'Position 1 is the most recent digit, 2 is the one before that, and so on. ' +
                'Populated automatically — no "Store exit digit" block needed.'
            ),
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Exit digit at position'),
            description: localize(
                'Reads a specific digit from the automatic global exit digit history. ' +
                'Position 1 returns the most recent exit digit (max position: 25).'
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
