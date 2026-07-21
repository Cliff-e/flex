import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Contract Type Switcher block.
 *
 * Lets a running bot change its active contract before the next proposal /
 * purchase without immediately placing a trade.  Selecting "Disable" clears
 * the override and reverts to the contract selected in Trade Parameters.
 *
 * To add new contract types, append a row to CONTRACT_TYPE_OPTIONS — that is
 * the only place that needs updating.
 */

export const CONTRACT_TYPE_OPTIONS = [
    ['Disable', 'DISABLE'],
    ['Rise', 'CALL'],
    ['Fall', 'PUT'],
    ['Higher', 'CALL'],
    ['Lower', 'PUT'],
    ['Even', 'DIGITEVEN'],
    ['Odd', 'DIGITODD'],
    ['Matches', 'DIGITMATCH'],
    ['Differs', 'DIGITDIFF'],
    ['Over', 'DIGITOVER'],
    ['Under', 'DIGITUNDER'],
];

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
                    options: CONTRACT_TYPE_OPTIONS.map(([label, value]) => [localize(label), value]),
                },
            ],
            colour: window.Blockly.Colours.Special2.colour,
            colourSecondary: window.Blockly.Colours.Special2.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special2.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Switch the active contract type. Selecting "Disable" returns to the contract set in Trade Parameters. The change takes effect on the next proposal — no trade is placed immediately.'
            ),
            category: window.Blockly.Categories.Contract_Modifiers,
        };
    },
    meta() {
        return {
            display_name: localize('Contract Type Switcher'),
            description: localize(
                'Changes the active contract type for the next proposal and all subsequent proposals until another switch occurs. Select "Disable" to revert to the Trade Parameters contract. Use inside If/Else, loops, or recovery branches to build hybrid strategies.'
            ),
            key_words: localize('contract, switch, type, hybrid, disable'),
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
