import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Random Prediction block — picks a random digit in a min–max range and sets
 * it as the active prediction override.
 */

window.Blockly.Blocks.random_prediction = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Set Random Prediction between {{ min }} and {{ max }}', {
                min: '%1',
                max: '%2',
            }),
            args0: [
                {
                    type: 'input_value',
                    name: 'MIN',
                    check: 'Number',
                },
                {
                    type: 'input_value',
                    name: 'MAX',
                    check: 'Number',
                },
            ],
            colour: window.Blockly.Colours.Special2.colour,
            colourSecondary: window.Blockly.Colours.Special2.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special2.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Picks a random digit between min and max (inclusive) and uses it as the active prediction for the next purchase.'
            ),
            category: window.Blockly.Categories.Prediction_Controls,
        };
    },
    meta() {
        return {
            display_name: localize('Set Random Prediction'),
            description: localize(
                'Randomly selects a digit between the specified min and max values and applies it as the prediction override for prediction-based contracts (Matches, Differs, Over, Under).'
            ),
            key_words: localize('prediction, random, digit, range'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.random_prediction = block => {
    const min =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'MIN',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
        ) || '0';
    const max =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'MAX',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
        ) || '9';
    return `Bot.setRandomPrediction(${min}, ${max});\n`;
};
