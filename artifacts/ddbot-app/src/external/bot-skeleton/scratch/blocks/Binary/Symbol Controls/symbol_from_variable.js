import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Symbol From Variable block — applies any string value as the active symbol
 * override. Useful when the symbol is computed or stored in a variable.
 */

window.Blockly.Blocks.symbol_from_variable = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Set Symbol from {{ value }}', { value: '%1' }),
            args0: [
                {
                    type: 'input_value',
                    name: 'VALUE',
                    check: 'String',
                },
            ],
            colour: window.Blockly.Colours.Special2.colour,
            colourSecondary: window.Blockly.Colours.Special2.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special2.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Applies a string variable or text value as the active symbol override. Accepts any valid Deriv market symbol (e.g. "R_75", "1HZ100V").'
            ),
            category: window.Blockly.Categories.Symbol_Controls,
        };
    },
    meta() {
        return {
            display_name: localize('Symbol From Variable'),
            description: localize(
                'Sets the active market symbol from any string input, variable, or computed text. Use when the target symbol changes dynamically based on strategy logic.'
            ),
            key_words: localize('symbol, variable, dynamic, market'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.symbol_from_variable = block => {
    const value =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'VALUE',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
        ) || "'DISABLE'";
    return `Bot.setActiveSymbol(${value});\n`;
};
