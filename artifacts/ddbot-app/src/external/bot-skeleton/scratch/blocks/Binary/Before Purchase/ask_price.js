import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';
import { CONTRACT_TYPE_OPTIONS_NO_DISABLE } from './contract-registry';

/**
 * Ask Price block.
 *
 * Returns the ask price for the selected contract type.  Uses the shared
 * contract registry — static, never filtered by Trade Parameters.
 * DISABLE is excluded because "ask price of the runtime contract" is not a
 * meaningful query at the Blockly level.
 */
window.Blockly.Blocks.ask_price = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Ask Price {{ contract_type }}', { contract_type: '%1' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'PURCHASE_LIST',
                    options: CONTRACT_TYPE_OPTIONS_NO_DISABLE.map(([label, value]) => [localize(label), value]),
                },
            ],
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: localize('Returns the purchase price for the selected contract type.'),
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Purchase price'),
            description: localize(
                'Returns the purchase price for the selected contract type. ' +
                'Can only be used inside the Purchase conditions block.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.ask_price = block => {
    const purchaseList = block.getFieldValue('PURCHASE_LIST');
    const code = `Bot.getAskPrice('${purchaseList}')`;
    return [code, window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
