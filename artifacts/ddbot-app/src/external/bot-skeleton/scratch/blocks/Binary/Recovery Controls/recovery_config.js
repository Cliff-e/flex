import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Recovery Config block — atomically sets contract type, prediction, and symbol
 * as a single recovery configuration step.  Any input left blank is unchanged.
 * Typically placed in an "If Mode is Recovery then …" branch.
 */

window.Blockly.Blocks.recovery_config = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize(
                'Recovery Config: Contract {{ contract }} Prediction {{ prediction }} Symbol {{ symbol }}',
                { contract: '%1', prediction: '%2', symbol: '%3' }
            ),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'CONTRACT',
                    options: [
                        [localize('(unchanged)'), 'KEEP'],
                        [localize('Disable'),     'DISABLE'],
                        [localize('Rise'),        'CALL'],
                        [localize('Fall'),        'PUT'],
                        [localize('Even'),        'DIGITEVEN'],
                        [localize('Odd'),         'DIGITODD'],
                        [localize('Matches'),     'DIGITMATCH'],
                        [localize('Differs'),     'DIGITDIFF'],
                        [localize('Over'),        'DIGITOVER'],
                        [localize('Under'),       'DIGITUNDER'],
                    ],
                },
                {
                    type: 'input_value',
                    name: 'PREDICTION',
                    check: 'Number',
                },
                {
                    type: 'field_dropdown',
                    name: 'SYMBOL',
                    options: [
                        [localize('(unchanged)'),             'KEEP'],
                        [localize('Disable'),                 'DISABLE'],
                        [localize('Vol 10 (1s)'),             '1HZ10V'],
                        [localize('Vol 10'),                  'R_10'],
                        [localize('Vol 25 (1s)'),             '1HZ25V'],
                        [localize('Vol 25'),                  'R_25'],
                        [localize('Vol 50 (1s)'),             '1HZ50V'],
                        [localize('Vol 50'),                  'R_50'],
                        [localize('Vol 75 (1s)'),             '1HZ75V'],
                        [localize('Vol 75'),                  'R_75'],
                        [localize('Vol 100 (1s)'),            '1HZ100V'],
                        [localize('Vol 100'),                 'R_100'],
                    ],
                },
            ],
            colour: window.Blockly.Colours.Special3.colour,
            colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Atomically sets contract type, prediction, and symbol for a recovery phase. Choose "(unchanged)" to leave any setting as-is. When the mode returns to Normal, call the same block with "(unchanged)" and the original values to restore the previous configuration.'
            ),
            category: window.Blockly.Categories.Recovery_Controls,
        };
    },
    meta() {
        return {
            display_name: localize('Recovery Config'),
            description: localize(
                'A single block that configures contract type, prediction, and symbol simultaneously for a recovery phase. Any field set to "(unchanged)" is left as-is. Use inside an "If Mode is Recovery" branch to switch to a different trading approach on a loss.'
            ),
            key_words: localize('recovery, config, contract, prediction, symbol, mode'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.recovery_config = block => {
    const contract   = block.getFieldValue('CONTRACT');
    const symbol     = block.getFieldValue('SYMBOL');
    const prediction =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'PREDICTION',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
        ) || 'null';

    const lines = [];
    if (contract !== 'KEEP') lines.push(`Bot.setActiveContract('${contract}');`);
    if (prediction !== 'null') lines.push(`Bot.setActivePrediction(${prediction});`);
    if (symbol !== 'KEEP') lines.push(`Bot.setActiveSymbol('${symbol}');`);
    return lines.join('\n') + '\n';
};
