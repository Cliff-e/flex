import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';
import { ALL_CONTRACT_TYPE_OPTIONS } from '../Before Purchase/contract-registry';

/**
 * Contract Type Switcher block.
 *
 * Lets a running bot change the active contract before the next proposal /
 * purchase without immediately placing a trade.  Selecting "Disable (Use
 * Runtime)" clears the override and reverts to the contract selected in
 * Trade Parameters.
 *
 * Uses the shared contract registry — same full list as the Purchase blocks,
 * never filtered by Trade Parameters.
 */

window.Blockly.Blocks.contract_type_switcher = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Current Active Contract {{ contract_type }}', { contract_type: '%1' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'CONTRACT_TYPE',
                    options: ALL_CONTRACT_TYPE_OPTIONS.map(([label, value]) => [localize(label), value]),
                },
            ],
            colour: window.Blockly.Colours.Special2.colour,
            colourSecondary: window.Blockly.Colours.Special2.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special2.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Switch the active contract type. "Disable (Use Runtime)" reverts to the contract ' +
                'set in Trade Parameters. The change takes effect on the next proposal — no trade ' +
                'is placed immediately.'
            ),
            category: window.Blockly.Categories.Contract_Modifiers,
        };
    },
    meta() {
        return {
            display_name: localize('Contract Type Switcher'),
            description: localize(
                'Changes the active contract type for the next proposal and all subsequent ' +
                'proposals until another switch occurs. Select "Disable (Use Runtime)" to revert ' +
                'to the Trade Parameters contract. Use inside If/Else, loops, or recovery branches ' +
                'to build hybrid strategies.'
            ),
            key_words: localize('contract, switch, type, hybrid, disable, rise, fall, even, odd, over, under'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.contract_type_switcher = block => {
    const contract_type = block.getFieldValue('CONTRACT_TYPE');
    return `Bot.setActiveContract('${contract_type}');\n`;
};
