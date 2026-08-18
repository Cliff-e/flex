import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Symbol Rotation block — advances through a predefined group of symbols in a
 * round-robin sequence, one step per call.
 */

window.Blockly.Blocks.symbol_rotation = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Rotate Symbol through {{ group }}', { group: '%1' }),
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
                'Advances the active symbol one step forward through the chosen group on each call, cycling back to the start after reaching the end.'
            ),
            category: window.Blockly.Categories.Symbol_Controls,
        };
    },
    meta() {
        return {
            display_name: localize('Symbol Rotation'),
            description: localize(
                'Cycles through a group of volatility indices in order, advancing one step each time the block executes. When the last symbol in the group is reached, the rotation wraps back to the first.'
            ),
            key_words: localize('symbol, rotation, cycle, round-robin, market'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.symbol_rotation = block => {
    const group = block.getFieldValue('GROUP');
    return `Bot.rotateSymbol('${group}');\n`;
};
