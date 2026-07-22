import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Virtual Hook Status reporter block.
 *
 * Returns true while the Virtual Hook is actively running virtual
 * (simulated) trades, and false when the bot is in real trading mode.
 * Use inside If / Else, loops, recovery branches, or variable assignments
 * to adapt strategy logic based on whether virtual or real trading is active.
 */
window.Blockly.Blocks.virtual_hook_status = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('VirtualHookStatus'),
            output: 'Boolean',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Special3.colour,
            colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
            tooltip: localize(
                'Returns true when the Virtual Hook is currently active (running virtual trades), and false when the bot is in real trading mode.'
            ),
            category: window.Blockly.Categories.Virtual_Hook,
        };
    },
    meta() {
        return {
            display_name: localize('Virtual Hook Status'),
            description: localize('This block returns if virtual hook is active or not.'),
            key_words: localize('virtual, hook, status, active, is, check, bool'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.virtual_hook_status = () => {
    return ['Bot.getVirtualHookStatus()', window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
