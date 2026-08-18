import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Set Mode block — writes a named execution mode into the shared RuntimeContext.
 * Pre-defined modes: NORMAL, RECOVERY, WAIT, PAUSE, CUSTOM.
 * A custom text input is shown when CUSTOM is selected.
 */

export const MODE_OPTIONS = [
    ['Normal',   'NORMAL'],
    ['Recovery', 'RECOVERY'],
    ['Wait',     'WAIT'],
    ['Pause',    'PAUSE'],
    ['Custom',   'CUSTOM'],
];

window.Blockly.Blocks.set_mode = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Set Mode to {{ mode }}', { mode: '%1' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'MODE',
                    options: MODE_OPTIONS.map(([label, value]) => [localize(label), value]),
                },
            ],
            colour: window.Blockly.Colours.Special3.colour,
            colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Sets the current runtime execution mode. Use with If Mode Equals to build a state-driven bot without nested IF blocks.'
            ),
            category: window.Blockly.Categories.Runtime_State,
        };
    },
    meta() {
        return {
            display_name: localize('Set Mode'),
            description: localize(
                'Sets the current bot execution mode (NORMAL, RECOVERY, WAIT, PAUSE, or CUSTOM). Pair with the "If Mode Equals" block to branch logic based on state without chaining nested IFs.'
            ),
            key_words: localize('mode, state, set, runtime, normal, recovery'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.set_mode = block => {
    const mode = block.getFieldValue('MODE');
    return `Bot.setMode('${mode}');\n`;
};
