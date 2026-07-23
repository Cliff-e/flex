import { localize } from '@deriv-com/translations';
import { excludeOptionFromContextMenu, modifyContextMenu } from '../../../utils';

/**
 * Purchase (All Contract Types)
 *
 * Like the standard `purchase` block but exposes a static dropdown with every
 * supported contract type so the user can buy any contract regardless of what
 * the Trade Definition block has currently selected.
 *
 * The generator intentionally reuses the same Bot.purchase() call so no
 * duplicate purchase logic is introduced.
 */

const ALL_CONTRACT_OPTIONS = () => [
    [localize('Rise'), 'CALL'],
    [localize('Fall'), 'PUT'],
    [localize('Rise Equals'), 'CALLE'],
    [localize('Fall Equals'), 'PUTE'],
    [localize('Higher'), 'CALL'],
    [localize('Lower'), 'PUT'],
    [localize('Touch'), 'ONETOUCH'],
    [localize('No Touch'), 'NOTOUCH'],
    [localize('Ends Between'), 'EXPIRYRANGE'],
    [localize('Ends Outside'), 'EXPIRYMISS'],
    [localize('Matches'), 'DIGITMATCH'],
    [localize('Differs'), 'DIGITDIFF'],
    [localize('Even'), 'DIGITEVEN'],
    [localize('Odd'), 'DIGITODD'],
    [localize('Over'), 'DIGITOVER'],
    [localize('Under'), 'DIGITUNDER'],
    [localize('Reset Call'), 'RESETCALL'],
    [localize('Reset Put'), 'RESETPUT'],
    [localize('Only Ups'), 'RUNHIGH'],
    [localize('Only Downs'), 'RUNLOW'],
    [localize('Call Spread'), 'CALLSPREAD'],
    [localize('Put Spread'), 'PUTSPREAD'],
];

window.Blockly.Blocks.purchase_all_contracts = {
    init() {
        this.jsonInit(this.definition());

        // Only one purchase block per branch — same constraint as the standard block.
        this.setNextStatement(false);
    },
    definition() {
        return {
            message0: localize('Purchase {{ contract_type }}', { contract_type: '%1' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'PURCHASE_LIST',
                    options: ALL_CONTRACT_OPTIONS(),
                },
            ],
            previousStatement: null,
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            tooltip: localize('This block purchases any contract type regardless of the current Trade Definition selection.'),
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Purchase (All Contract Types)'),
            description: localize(
                'Use this block to purchase the specific contract you want. You may add multiple Purchase blocks together with conditional blocks to define your purchase conditions. This block can only be used within the Purchase conditions block.'
            ),
            key_words: localize('buy, all, contracts, purchase'),
        };
    },
    customContextMenu(menu) {
        const menu_items = [localize('Enable Block'), localize('Disable Block')];
        excludeOptionFromContextMenu(menu, menu_items);
        modifyContextMenu(menu);
    },
    restricted_parents: ['before_purchase'],
};

// Reuse the same Bot.purchase() execution path — no duplicate purchase logic.
window.Blockly.JavaScript.javascriptGenerator.forBlock.purchase_all_contracts = block => {
    const purchaseList = block.getFieldValue('PURCHASE_LIST');
    return `Bot.purchase('${purchaseList}');\n`;
};
