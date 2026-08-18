import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * clear_exit_digit_history — statement block
 *
 * Wipes the global rolling exit-digit history immediately.
 * Useful at the start of a strategy reset or when you want fresh data
 * mid-session without stopping the bot.
 */
window.Blockly.Blocks.clear_exit_digit_history = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Clear exit digit history'),
            previousStatement: null,
            nextStatement: null,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: localize(
                'Empties the rolling exit-digit history immediately. ' +
                'Use this to reset the sample when switching strategy mid-session.'
            ),
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Clear exit digit history'),
            description: localize('Wipes all stored exit digits so the rolling buffer starts fresh.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.clear_exit_digit_history = () => {
    return 'Bot.clearExitDigitHistory();\n';
};
