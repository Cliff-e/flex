import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * get_last_exit_digit — value block
 *
 * Returns the most recent exit digit from the global rolling history.
 * No "Store" block needed — the runtime records every settled contract
 * automatically.
 */
window.Blockly.Blocks.get_last_exit_digit = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Last exit digit'),
            output: null,
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: localize(
                'Returns the exit digit of the most recently completed contract. ' +
                'Returns null when no trades have settled yet this session.'
            ),
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Last exit digit'),
            description: localize(
                'Reads the last digit of the exit tick from the most recently settled contract.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.get_last_exit_digit = () => {
    const code = 'Bot.getLastExitDigit()';
    return [code, window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
