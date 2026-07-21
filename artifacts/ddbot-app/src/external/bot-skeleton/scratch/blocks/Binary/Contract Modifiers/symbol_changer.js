import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Symbol Changer block.
 *
 * Lets a running bot switch the market symbol before the next proposal
 * request.  Selecting "Disable" clears the override and reverts to the
 * symbol selected in Trade Parameters.
 *
 * To add new symbols, append a row to SYMBOL_OPTIONS — that is the only
 * place that needs updating.
 */

export const SYMBOL_OPTIONS = [
    ['Disable', 'DISABLE'],
    ['Volatility 10 (1s) Index', '1HZ10V'],
    ['Volatility 10 Index', 'R_10'],
    ['Volatility 25 (1s) Index', '1HZ25V'],
    ['Volatility 25 Index', 'R_25'],
    ['Volatility 50 (1s) Index', '1HZ50V'],
    ['Volatility 50 Index', 'R_50'],
    ['Volatility 75 (1s) Index', '1HZ75V'],
    ['Volatility 75 Index', 'R_75'],
    ['Volatility 100 (1s) Index', '1HZ100V'],
    ['Volatility 100 Index', 'R_100'],
];

window.Blockly.Blocks.symbol_changer = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Symbol Changer Status {{ symbol }}', { symbol: '%1' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'SYMBOL',
                    options: SYMBOL_OPTIONS.map(([label, value]) => [localize(label), value]),
                },
            ],
            colour: window.Blockly.Colours.Special2.colour,
            colourSecondary: window.Blockly.Colours.Special2.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special2.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Switch the active market symbol. Selecting "Disable" returns to the symbol set in Trade Parameters. Cancels cached proposals for the old symbol and requests fresh ones for the new symbol immediately.'
            ),
            category: window.Blockly.Categories.Contract_Modifiers,
        };
    },
    meta() {
        return {
            display_name: localize('Symbol Changer'),
            description: localize(
                'Changes the active market symbol for the next proposal and all subsequent proposals until another Symbol Changer executes. Select "Disable" to revert to the Trade Parameters symbol.'
            ),
            key_words: localize('symbol, market, switch, volatility, disable'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.symbol_changer = block => {
    const symbol = block.getFieldValue('SYMBOL');
    return `Bot.setActiveSymbol('${symbol}');\n`;
};
