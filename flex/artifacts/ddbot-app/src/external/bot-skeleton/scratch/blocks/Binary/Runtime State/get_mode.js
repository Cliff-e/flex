import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Get Mode block — reads the current mode from RuntimeContext and returns it as a string.
 * Use inside comparisons to check the active state without a variable lookup.
 */

window.Blockly.Blocks.get_mode = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Get Current Mode'),
            output: 'String',
            colour: window.Blockly.Colours.Special3.colour,
            colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
            tooltip: localize(
                'Returns the current execution mode as a text string (e.g. "NORMAL", "RECOVERY"). Use inside a logic compare block to branch on the current state.'
            ),
            category: window.Blockly.Categories.Runtime_State,
        };
    },
    meta() {
        return {
            display_name: localize('Get Current Mode'),
            description: localize(
                'Returns the current bot execution mode as a string. Use with logic comparison blocks to check whether the bot is in NORMAL, RECOVERY, WAIT, PAUSE, or CUSTOM mode.'
            ),
            key_words: localize('mode, get, state, runtime, current'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.get_mode = () => {
    return [`Bot.getMode()`, window.Blockly.JavaScript.javascriptGenerator.ORDER_FUNCTION_CALL];
};
