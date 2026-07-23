import { localize } from '@deriv-com/translations';
import { getContractTypeOptions } from '../../../shared';
import { excludeOptionFromContextMenu, modifyContextMenu } from '../../../utils';

/**
 * Purchase (All Contract Types)
 *
 * Identical behaviour to the standard `purchase` block — dynamic dropdown,
 * same onchange/populatePurchaseList logic, same Bot.purchase() generator.
 *
 * The only difference is that it always passes 'both' as the contract_type
 * filter to getContractTypeOptions, exposing every contract available for the
 * current trade type rather than only the one selected in Trade Definition.
 * This lets users build strategies that explicitly buy any supported contract.
 *
 * No purchase logic is duplicated — this block shares the same execution path.
 */
window.Blockly.Blocks.purchase_all_contracts = {
    init() {
        this.jsonInit(this.definition());

        // One purchase leaf per branch — same constraint as the standard block.
        this.setNextStatement(false);
    },
    definition() {
        return {
            message0: localize('Purchase {{ contract_type }}', { contract_type: '%1' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'PURCHASE_LIST',
                    options: [['', '']],
                },
            ],
            previousStatement: null,
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            tooltip: localize('This block purchases any available contract type for the current trade type.'),
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
    // Identical to purchase.js — single source of truth is getContractTypeOptions.
    onchange(event) {
        if (!this.workspace || window.Blockly.derivWorkspace.isFlyoutVisible || this.workspace.isDragging()) {
            return;
        }

        if (event.type === window.Blockly.Events.BLOCK_CREATE && event.ids.includes(this.id)) {
            this.populatePurchaseList(event);
        } else if (event.type === window.Blockly.Events.BLOCK_CHANGE) {
            if (event.name === 'TYPE_LIST' || event.name === 'TRADETYPE_LIST') {
                this.populatePurchaseList(event);
            }
        } else if (event.type === window.Blockly.Events.BLOCK_DRAG && !event.isStart && event.blockId === this.id) {
            const purchase_type_list = this.getField('PURCHASE_LIST');
            const purchase_options = purchase_type_list.menuGenerator_; // eslint-disable-line

            if (purchase_options[0][0] === '') {
                this.populatePurchaseList(event);
            }
        }
    },
    // Always fetches 'both' sides so all contract types are available.
    populatePurchaseList(event) {
        const trade_definition_block = this.workspace.getTradeDefinitionBlock();

        if (trade_definition_block) {
            const trade_type_block = trade_definition_block.getChildByType('trade_definition_tradetype');
            const trade_type = trade_type_block.getFieldValue('TRADETYPE_LIST');
            const purchase_type_list = this.getField('PURCHASE_LIST');
            const purchase_type = purchase_type_list.getValue();

            // Pass 'both' to retrieve every contract type for this trade type,
            // not just the one currently selected in the Contract Type block.
            const contract_type_options = getContractTypeOptions('both', trade_type);

            purchase_type_list.updateOptions(contract_type_options, {
                default_value: purchase_type,
                event_group: event.group,
                should_pretend_empty: true,
            });
        }
    },
    customContextMenu(menu) {
        const menu_items = [localize('Enable Block'), localize('Disable Block')];
        excludeOptionFromContextMenu(menu, menu_items);
        modifyContextMenu(menu);
    },
    restricted_parents: ['before_purchase'],
};

// Reuses Bot.purchase() — identical generator to the standard purchase block.
window.Blockly.JavaScript.javascriptGenerator.forBlock.purchase_all_contracts = block => {
    const purchaseList = block.getFieldValue('PURCHASE_LIST');
    return `Bot.purchase('${purchaseList}');\n`;
};
