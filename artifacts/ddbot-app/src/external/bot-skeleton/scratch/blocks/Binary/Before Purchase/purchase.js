import { localize } from '@deriv-com/translations';
import { excludeOptionFromContextMenu, modifyContextMenu } from '../../../utils';

/**
 * Full static list of every purchasable contract type.
 *
 * This intentionally does NOT depend on Trade Parameters — the user can
 * pick any type here and combine it with Symbol Controls / Contract Type
 * Switcher to build cross-type strategies (e.g. recover Vol 10 DIGITOVER
 * losses with Vol 75 1s DIGITEVEN).
 *
 * Exported so other blocks (purchase_all_contracts, toolbox) can reuse it.
 */
export const ALL_CONTRACT_TYPE_OPTIONS = [
    ['Rise (Call)',        'CALL'],
    ['Fall (Put)',         'PUT'],
    ['Even',              'DIGITEVEN'],
    ['Odd',               'DIGITODD'],
    ['Matches',           'DIGITMATCH'],
    ['Differs',           'DIGITDIFF'],
    ['Over',              'DIGITOVER'],
    ['Under',             'DIGITUNDER'],
    ['Touch',             'ONETOUCH'],
    ['No Touch',          'NOTOUCH'],
    ['Ends Between',      'EXPIRYRANGE'],
    ['Ends Outside',      'EXPIRYMISS'],
    ['Reset Call',        'RESETCALL'],
    ['Reset Put',         'RESETPUT'],
    ['Only Ups',          'RUNHIGH'],
    ['Only Downs',        'RUNLOW'],
    ['Call Spread',       'CALLSPREAD'],
    ['Put Spread',        'PUTSPREAD'],
];

window.Blockly.Blocks.purchase = {
    init() {
        this.jsonInit(this.definition());

        // Ensure one of this type per statement-stack
        this.setNextStatement(false);
    },
    definition() {
        return {
            message0: localize('Purchase {{ contract_type }}', { contract_type: '%1' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'PURCHASE_LIST',
                    options: ALL_CONTRACT_TYPE_OPTIONS.map(([label, value]) => [localize(label), value]),
                },
            ],
            previousStatement: null,
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            tooltip: localize(
                'Purchase a specific contract type. The full list of types is available — ' +
                'the choice is not limited by Trade Parameters. Combine with Symbol Controls ' +
                'and Contract Type Switcher to build cross-type strategies (e.g. trade ' +
                'Over/Under on Vol 10 and recover with Even/Odd on Vol 75 1s).'
            ),
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Purchase'),
            description: localize(
                'Purchases the selected contract type. The dropdown shows every available ' +
                'type (Rise, Fall, Even, Odd, Matches, Differs, Over, Under, Touch, No Touch, ' +
                'and more) regardless of what is set in Trade Parameters. Use multiple Purchase ' +
                'blocks inside conditional logic to build multi-type and recovery strategies.'
            ),
            key_words: localize('buy, purchase, rise, fall, even, odd, over, under, matches, differs'),
        };
    },
    customContextMenu(menu) {
        const menu_items = [localize('Enable Block'), localize('Disable Block')];
        excludeOptionFromContextMenu(menu, menu_items);
        modifyContextMenu(menu);
    },
    restricted_parents: ['before_purchase'],
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.purchase = block => {
    const purchaseList = block.getFieldValue('PURCHASE_LIST');
    return `Bot.purchase('${purchaseList}');\n`;
};
