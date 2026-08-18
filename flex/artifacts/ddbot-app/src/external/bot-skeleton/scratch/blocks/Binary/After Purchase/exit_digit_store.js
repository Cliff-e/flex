import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * exit_digit_store — statement block
 *
 * Reads the last contract's exit digit (last digit of the exit tick price)
 * and pushes it into a rolling buffer of configurable size.
 * When the buffer is full the oldest entry is discarded.
 *
 * Use inside an "After Purchase" scope.
 */
window.Blockly.Blocks.exit_digit_store = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Store exit digit  (keep last {{ n }} digits)', { n: '%1' }),
            args0: [
                {
                    type: 'field_number',
                    name: 'BUFFER_SIZE',
                    value: 25,
                    min: 1,
                    max: 500,
                    precision: 1,
                },
            ],
            previousStatement: null,
            nextStatement: null,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: localize(
                'Captures the exit digit of the last contract and stores it in a rolling buffer. ' +
                'The oldest digit is automatically removed when the buffer exceeds the chosen size.'
            ),
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Store exit digit'),
            description: localize(
                'Records the last digit of the exit tick into a rolling memory. ' +
                'Default size is 25 — once the 26th digit arrives the first one is dropped.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
    restricted_parents: ['after_purchase'],
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.exit_digit_store = block => {
    const bufferSize = block.getFieldValue('BUFFER_SIZE') || 25;
    return `Bot.storeExitDigit(${bufferSize});\n`;
};
