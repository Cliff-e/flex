import { localize } from '@deriv-com/translations';
import { excludeOptionFromContextMenu, modifyContextMenu } from '../../../utils';
import { ALL_CONTRACT_TYPE_OPTIONS } from './contract-registry';

/**
 * Purchase (Advanced) block — block type id: `purchase_all_contracts`
 *
 * Adds two fields on top of the standard Purchase block:
 *   • Allow Bulk Purchase (Yes / No)
 *   • No. of Trades       (number, active only when Bulk = Yes)
 *
 * The contract dropdown uses the same shared registry as every other
 * Purchase-related block and is never filtered by Trade Parameters.
 *
 * Backward compatibility
 * ──────────────────────
 * Old XML that only contains a PURCHASE_LIST field will load correctly —
 * ALLOW_BULK defaults to 'no' and NUM_TRADES defaults to 1, preserving the
 * original single-purchase behaviour.
 *
 * Old XML with a PURCHASE_LIST value that no longer exists in the registry
 * (e.g. an empty string or "NOT_AVAILABLE") will fall back to the first
 * registry entry ("Disable (Use Runtime)") because DISABLE is listed first.
 */
window.Blockly.Blocks.purchase_all_contracts = {
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
            message1: localize('Allow Bulk Purchase: {{ allow }}', { allow: '%1' }),
            args1: [
                {
                    type: 'field_dropdown',
                    name: 'ALLOW_BULK',
                    options: [
                        [localize('No'),  'no'],
                        [localize('Yes'), 'yes'],
                    ],
                },
            ],
            message2: localize('No. of Trades: {{ num }}', { num: '%1' }),
            args2: [
                {
                    type: 'field_number',
                    name: 'NUM_TRADES',
                    value: 1,
                    min: 1,
                    max: 100,
                    precision: 1,
                },
            ],
            previousStatement: null,
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            tooltip: localize(
                'Advanced purchase block. "Disable (Use Runtime)" defers to the Contract Changer ' +
                'block or Trade Parameters. Any other selection overrides the contract for this ' +
                'purchase only. Enable Bulk Purchase to execute the same contract multiple times ' +
                'in one cycle. The full contract list is always shown regardless of Trade Parameters.'
            ),
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Purchase (Advanced)'),
            description: localize(
                'Advanced purchase block with optional bulk execution. ' +
                '"Disable (Use Runtime)" uses the active contract from Trade Parameters or the ' +
                'Contract Changer block. Enable "Allow Bulk Purchase" and set "No. of Trades" to ' +
                'buy the same contract multiple times per cycle. The complete contract list is ' +
                'always available — never filtered by Trade Parameters.'
            ),
            key_words: localize('buy, all, contracts, purchase, bulk, advanced, rise, fall, even, odd, over, under'),
        };
    },
    customContextMenu(menu) {
        const menu_items = [localize('Enable Block'), localize('Disable Block')];
        excludeOptionFromContextMenu(menu, menu_items);
        modifyContextMenu(menu);
    },
    restricted_parents: ['before_purchase'],
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.purchase_all_contracts = block => {
    const purchaseList = block.getFieldValue('PURCHASE_LIST');
    const allowBulk   = block.getFieldValue('ALLOW_BULK');
    const numTrades   = Math.max(1, parseInt(block.getFieldValue('NUM_TRADES'), 10) || 1);

    if (allowBulk === 'yes' && numTrades > 1) {
        // Delegate to the engine-level bulk method which holds the scope guard
        // open for the entire batch and only dispatches purchaseSuccessful()
        // after the final buy — fixing the bug where only the first purchase
        // executed because every subsequent Bot.purchase() call saw scope ===
        // DURING_PURCHASE and returned early.
        return `Bot.purchaseMultiple('${purchaseList}', ${numTrades});\n`;
    }

    return `Bot.purchase('${purchaseList}');\n`;
};
