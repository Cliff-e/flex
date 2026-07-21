import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Virtual Hook Enable / Disable block.
 *
 * Turns the Virtual Hook engine on or off.  When enabled, the engine runs
 * the configured number of virtual (simulated) trades before allowing any
 * real trade to be placed.  When disabled, the bot trades exactly like
 * standard DBot with no virtual warm-up.
 */
window.Blockly.Blocks.virtual_hook_toggle = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Virtual Hook {{ state }}', { state: '%1' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'STATE',
                    options: [
                        [localize('Disable'), 'DISABLE'],
                        [localize('Enable'), 'ENABLE'],
                    ],
                },
            ],
            colour: window.Blockly.Colours.Special3.colour,
            colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Enable or Disable the Virtual Hook engine. When enabled the bot runs simulated trades before placing real ones. When disabled the bot trades normally.'
            ),
            category: window.Blockly.Categories.Virtual_Hook,
        };
    },
    meta() {
        return {
            display_name: localize('Enable / Disable Virtual Hook'),
            description: localize(
                'Toggles the Virtual Hook system on or off. When enabled, the bot first runs a configured number of virtual (simulated) trades before executing real trades. Disable to run the bot normally without any virtual warm-up sequence.'
            ),
            key_words: localize('virtual, hook, enable, disable, toggle, simulate'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.virtual_hook_toggle = block => {
    const state = block.getFieldValue('STATE');
    return `Bot.setVirtualHookEnabled(${state === 'ENABLE' ? 'true' : 'false'});\n`;
};
