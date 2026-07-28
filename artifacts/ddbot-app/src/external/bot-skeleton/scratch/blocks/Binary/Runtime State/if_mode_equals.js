import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * If Mode Equals block — a convenience conditional that branches on the
 * current runtime mode without requiring a variables_get + logic_compare chain.
 */

window.Blockly.Blocks.if_mode_equals = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('If Mode is {{ mode }} then {{ do }}', { mode: '%1', do: '%2' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'MODE',
                    options: [
                        [localize('Normal'),   'NORMAL'],
                        [localize('Recovery'), 'RECOVERY'],
                        [localize('Wait'),     'WAIT'],
                        [localize('Pause'),    'PAUSE'],
                        [localize('Custom'),   'CUSTOM'],
                    ],
                },
                {
                    type: 'input_statement',
                    name: 'DO',
                },
            ],
            colour: window.Blockly.Colours.Special3.colour,
            colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Runs the inner blocks only when the current execution mode matches the selected value. Equivalent to: If (Get Current Mode == "MODE") then ...'
            ),
            category: window.Blockly.Categories.Runtime_State,
        };
    },
    meta() {
        return {
            display_name: localize('If Mode Equals'),
            description: localize(
                'A shorthand conditional: runs the inner blocks only when the bot is in the chosen execution mode. Cleaner than a full If + Get Mode + Compare chain.'
            ),
            key_words: localize('mode, if, equals, state, runtime, condition'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.if_mode_equals = block => {
    const mode = block.getFieldValue('MODE');
    const body =
        window.Blockly.JavaScript.javascriptGenerator.statementToCode(block, 'DO') || '';
    return `if (Bot.getMode() === '${mode}') {\n${body}}\n`;
};
