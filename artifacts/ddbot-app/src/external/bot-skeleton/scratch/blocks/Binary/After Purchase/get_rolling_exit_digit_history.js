import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * get_rolling_exit_digit_history — value block
 *
 * Returns the latest 21 exit digits from the canonical shared exit-digit
 * history. The shared history already contains the project's accepted REAL
 * and committed VH entries, in oldest-to-newest order.
 *
 * This compatibility block expands to the proven individual-position
 * accessors. It returns the complete available history before the 21-entry
 * threshold, and only evaluates positions 21 through 1 once the threshold is
 * met. That prevents null padding while preserving chronological ordering.
 */
window.Blockly.Blocks.get_rolling_exit_digit_history = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('21 Rolling Exit Digit History'),
            output: 'Array',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: localize(
                'Returns up to 21 exit digits from the shared history, in chronological order. ' +
                    'Only available exit digits are included; no values are fabricated when fewer are available.'
            ),
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('21 Rolling Exit Digit History'),
            description: localize(
                'Returns up to 21 exit digits from the shared exit-digit history as a list.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.get_rolling_exit_digit_history = () => {
    const positions = Array.from({ length: 21 }, (_, index) => 21 - index)
        .map(position => `Bot.getExitDigitAt(${position})`)
        .join(', ');
    const code = `Bot.getExitDigitCount() >= 21 ? [${positions}] : Bot.getExitDigitList()`;
    return [code, window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};