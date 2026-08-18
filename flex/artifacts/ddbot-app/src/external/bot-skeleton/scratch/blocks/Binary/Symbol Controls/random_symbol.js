import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Random Symbol block — picks a random volatility index from a fixed list and
 * applies it as the active symbol override.
 */

export const RANDOM_SYMBOL_POOL = [
    '1HZ10V',
    'R_10',
    '1HZ25V',
    'R_25',
    '1HZ50V',
    'R_50',
    '1HZ75V',
    'R_75',
    '1HZ100V',
    'R_100',
];

window.Blockly.Blocks.random_symbol = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Set Random Symbol from {{ group }}', { group: '%1' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'GROUP',
                    options: [
                        [localize('All Volatility Indices'), 'ALL'],
                        [localize('1s Indices only'),        '1S'],
                        [localize('Standard Indices only'),  'STANDARD'],
                    ],
                },
            ],
            colour: window.Blockly.Colours.Special2.colour,
            colourSecondary: window.Blockly.Colours.Special2.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special2.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Picks a random volatility index from the selected group and applies it as the active symbol for the next proposal.'
            ),
            category: window.Blockly.Categories.Symbol_Controls,
        };
    },
    meta() {
        return {
            display_name: localize('Random Symbol'),
            description: localize(
                'Selects a random volatility index from All, 1s, or Standard groups and uses it as the active symbol override. Useful for multi-market strategies that rotate symbols unpredictably.'
            ),
            key_words: localize('symbol, random, volatility, market'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.random_symbol = block => {
    const group = block.getFieldValue('GROUP');
    return `Bot.setRandomSymbol('${group}');\n`;
};
