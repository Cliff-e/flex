import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Virtual Hook (Settings) block.
 *
     * Configures the three independent VH authorization conditions.
 */
window.Blockly.Blocks.virtual_hook_settings = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('set Virtual Hook Settings'),
            args0: [],
            message1: localize('Max wins enabled %1 threshold %2'),
            args1: [
                { type: 'field_checkbox', name: 'WIN_ENABLED', checked: true },
                {
                    type: 'input_value',
                    name: 'WIN_THRESHOLD',
                    check: 'Number',
                },
            ],
            message2: localize('Max losses enabled %1 threshold %2'),
            args2: [
                { type: 'field_checkbox', name: 'LOSS_ENABLED', checked: false },
                {
                    type: 'input_value',
                    name: 'LOSS_THRESHOLD',
                    check: 'Number',
                },
            ],
            message3: localize('Max VH instances enabled %1 threshold %2'),
            args3: [
                { type: 'field_checkbox', name: 'STEPS_ENABLED', checked: true },
                {
                    type: 'input_value',
                    name: 'MAX_STEPS',
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
            const win_threshold =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
                    'WIN_THRESHOLD',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
                ) || '3';
            const loss_threshold =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
                    'LOSS_THRESHOLD',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
                ) || '3';
            const max_steps =
                window.Blockly.JavaScript.javascriptGenerator.valueToCode(
                    block,
                    'MAX_STEPS',
                    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
                ) || '5';
            const win_enabled = block.getFieldValue('WIN_ENABLED') === 'TRUE';
            const loss_enabled = block.getFieldValue('LOSS_ENABLED') === 'TRUE';
            const steps_enabled = block.getFieldValue('STEPS_ENABLED') === 'TRUE';
            return `Bot.setVirtualHookSettings(${win_threshold}, ${win_enabled}, ${loss_threshold}, ${loss_enabled}, ${max_steps}, ${steps_enabled});\n`;
};
