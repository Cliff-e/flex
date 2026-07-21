import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Virtual Hook Settings block.
 *
 * Configures the number of virtual (simulated) trades to run before live
 * trading begins, and how many consecutive real wins cause the virtual
 * sequence to reset and run again.
 */
window.Blockly.Blocks.virtual_hook_settings = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Set Virtual Hook Settings: {{ virtual_trades }} virtual trades, reset after {{ real_wins }} real win(s)', {
                virtual_trades: '%1',
                real_wins: '%2',
            }),
            args0: [
                {
                    type: 'input_value',
                    name: 'VIRTUAL_TRADES',
                    check: 'Number',
                },
                {
                    type: 'input_value',
                    name: 'REAL_WINS',
                    check: 'Number',
                },
            ],
            colour: window.Blockly.Colours.Special3.colour,
            colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Configure the number of virtual trades to run before live trading begins, and how many real wins trigger a new virtual sequence.'
            ),
            category: window.Blockly.Categories.Virtual_Hook,
        };
    },
    meta() {
        return {
            display_name: localize('Set Virtual Hook Settings'),
            description: localize(
                'Configure the Virtual Hook engine. Set how many virtual (simulated) trades run before live trading begins, and how many consecutive real wins trigger a fresh virtual warm-up sequence.'
            ),
            key_words: localize('virtual, hook, settings, trades, wins, simulate, warm-up'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.virtual_hook_settings = block => {
    const virtual_trades =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'VIRTUAL_TRADES',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
        ) || '21';
    const real_wins =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'REAL_WINS',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
        ) || '1';
    return `Bot.setVirtualHookSettings(${virtual_trades}, ${real_wins});\n`;
};
