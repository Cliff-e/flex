import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Prediction From Variable block — applies an existing Blockly variable's
 * value as the active prediction override.
 */

window.Blockly.Blocks.prediction_from_variable = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Set Prediction from {{ value }}', { value: '%1' }),
            args0: [
                {
                    type: 'input_value',
                    name: 'VALUE',
                    check: 'Number',
                },
            ],
            colour: window.Blockly.Colours.Special2.colour,
            colourSecondary: window.Blockly.Colours.Special2.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special2.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Sets the active prediction to the value of any number input or variable. Useful when prediction is computed dynamically (e.g. last digit, tick analysis).'
            ),
            category: window.Blockly.Categories.Prediction_Controls,
        };
    },
    meta() {
        return {
            display_name: localize('Set Prediction from Variable'),
            description: localize(
                'Applies any numeric expression or variable as the active prediction override. Unlike Set Custom Prediction this accepts a computed value, not just a fixed number.'
            ),
            key_words: localize('prediction, variable, dynamic, digit'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.prediction_from_variable = block => {
    const value =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'VALUE',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
        ) || '-1';
    return `Bot.setActivePrediction(${value});\n`;
};
