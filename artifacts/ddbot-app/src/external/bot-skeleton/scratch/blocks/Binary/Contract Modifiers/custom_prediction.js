import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Custom Prediction Setter block.
 *
 * Sets the digit prediction (0–9) used by prediction-based contracts:
 * Matches, Differs, Over, Under.
 *
 * The override persists until another Set Custom Prediction block executes.
 * Pass -1 to clear the override and revert to Trade Parameters.
 * Contracts that do not use a prediction (Rise/Fall, Higher/Lower, Even/Odd)
 * are unaffected — the engine silently ignores the override for those types.
 *
 * Intended workflow:
 *   Switch Contract → Over
 *   Set Custom Prediction → 6
 *   Purchase
 */
window.Blockly.Blocks.custom_prediction = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Set Custom Prediction {{ prediction }}', { prediction: '%1' }),
            args0: [
                {
                    type: 'input_value',
                    name: 'PREDICTION',
                    check: 'Number',
                },
            ],
            colour: window.Blockly.Colours.Special2.colour,
            colourSecondary: window.Blockly.Colours.Special2.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special2.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Set the digit prediction (0–9) for prediction-based contracts (Matches, Differs, Over, Under). Pass -1 to revert to the Trade Parameters default. Ignored for contracts that do not require a prediction.'
            ),
            category: window.Blockly.Categories.Contract_Modifiers,
        };
    },
    meta() {
        return {
            display_name: localize('Set Custom Prediction'),
            description: localize(
                'Sets the digit prediction used for prediction-based contracts (Matches, Differs, Over, Under). The override persists until another Set Custom Prediction block runs. Use with the Contract Type Switcher to build hybrid strategies that switch both contract type and prediction dynamically.'
            ),
            key_words: localize('prediction, barrier, digit, set, custom, matches, differs, over, under'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.custom_prediction = block => {
    const prediction =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'PREDICTION',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
        ) || '-1';
    return `Bot.setActivePrediction(${prediction});\n`;
};
