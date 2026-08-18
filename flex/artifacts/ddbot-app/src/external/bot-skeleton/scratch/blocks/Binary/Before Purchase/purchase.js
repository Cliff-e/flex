import { localize } from '@deriv-com/translations';
import { excludeOptionFromContextMenu, modifyContextMenu } from '../../../utils';
import { ALL_CONTRACT_TYPE_OPTIONS, PURCHASE_DISABLE } from './contract-registry';

// Re-export for any existing consumers that imported from purchase.js directly.
export { ALL_CONTRACT_TYPE_OPTIONS, PURCHASE_DISABLE };

/**
 * Purchase block — simple execution block.
 *
 * Exposes a static full-registry dropdown that is NEVER filtered by Trade
 * Parameters.  Select "Disable (Use Runtime)" to defer to the Contract Changer
 * block or Trade Parameters; select any other type to override the contract
 * for this purchase only.
 */
window.Blockly.Blocks.purchase = {
    init() {
        this.jsonInit(this.definition());

        // Only one purchase leaf per statement stack.
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
                'Purchase a contract. "Disable (Use Runtime)" defers to the Contract Changer ' +
                'block or Trade Parameters. Any other selection overrides the contract for this ' +
                'purchase only without changing Trade Parameters. The full contract list is always ' +
                'available regardless of what is set in Trade Parameters.'
            ),
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Purchase'),
            description: localize(
                'Purchases a contract. "Disable (Use Runtime)" uses the active contract from ' +
                'Trade Parameters or the Contract Changer block. Any other selection overrides ' +
                'the contract type for this purchase only. The complete contract list is always ' +
                'shown — Rise, Fall, Higher, Lower, Even, Odd, Matches, Differs, Over, Under, ' +
                'Touch, No Touch, Ends Between, Ends Outside, Asian Up, Asian Down, Reset Call, ' +
                'Reset Put, Only Ups, Only Downs, Call Spread, Put Spread.'
            ),
            key_words: localize('buy, purchase, rise, fall, even, odd, over, under, matches, differs, higher, lower, asian, disable'),
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
