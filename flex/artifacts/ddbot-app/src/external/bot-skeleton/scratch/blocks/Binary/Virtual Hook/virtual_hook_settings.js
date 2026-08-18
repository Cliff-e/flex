import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Virtual Hook (Settings) block.
 *
 * Configures how many virtual (simulated) trades run before live trading
 * begins, and how many consecutive real wins cause the virtual sequence
 * to reset and run again.
 *
 * Internal field names (VIRTUAL_TRADES / REAL_WINS) are preserved so that
 * existing saved bots and XML imports continue to work without modification.
 */
window.Blockly.Blocks.virtual_hook_settings = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('set Virtual Hook Settings'),
            args0: [],
            message1: localize('No. of Virtual losses %1'),
            args1: [
                {
                    type: 'input_value',
                    name: 'VIRTUAL_TRADES',
                    check: 'Number',
                },
            ],
            message2: localize('No. of Wins on Real Trades %1'),
            args2: [
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
                'Configure the number of virtual trades to run before live trading begins, and how many consecutive real wins trigger a new virtual warm-up sequence.'
            ),
            category: window.Blockly.Categories.Virtual_Hook,
        };
    },
    meta() {
        return {
            display_name: localize('Virtual Hook'),
            description: localize(
                'Virtual Hook is an innovative trading tool designed to enhance the trading experience by allowing users to engage in virtual trades alongside live trading activities. This unique feature aims to minimize potential losses by offering the option to take partial virtual trades instead of committing fully to live trades.'
            ),
            key_words: localize('virtual, hook, settings, losses, wins, simulate, warm-up'),
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
