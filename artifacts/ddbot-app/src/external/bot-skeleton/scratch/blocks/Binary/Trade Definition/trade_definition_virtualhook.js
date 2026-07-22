import { localize } from '@deriv-com/translations';
import { excludeOptionFromContextMenu, modifyContextMenu } from '../../../utils';

/**
 * Virtual Hook block — a standalone Trade Parameters chain block.
 *
 * Sits after trade_definition_restartonerror in the default chain and
 * is the terminal block (no next statement allowed).  Configuration is
 * read by the trade_definition generator and emitted once inside
 * BinaryBotPrivateInit via Bot.setVirtualHookEnabled / setVirtualHookSettings.
 *
 * Field names are kept identical to the values already used by the runtime
 * so that the existing VirtualHookRuntime continues to work unchanged.
 */
window.Blockly.Blocks.trade_definition_virtualhook = {
    init() {
        this.jsonInit({
            message0: localize('Virtual Hook: Enable {{ state }}', { state: '%1' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'VH_ENABLED',
                    options: [
                        [localize('disable'), 'FALSE'],
                        [localize('enable'), 'TRUE'],
                    ],
                },
            ],
            message1: localize('No. of Virtual Losses {{ num }}', { num: '%1' }),
            args1: [
                {
                    type: 'field_number',
                    name: 'VH_VIRTUAL_TRADES',
                    value: 3,
                    min: 1,
                    precision: 1,
                },
            ],
            message2: localize('No. of Wins on Real Trades {{ num }}', { num: '%1' }),
            args2: [
                {
                    type: 'field_number',
                    name: 'VH_REAL_WINS',
                    value: 1,
                    min: 1,
                    precision: 1,
                },
            ],
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            previousStatement: null,
            nextStatement: null,
        });

        // Terminal block — nothing may follow Virtual Hook in the chain.
        this.setNextStatement(false);
        this.setMovable(false);
        this.setDeletable(false);
    },
    onchange(/* event */) {
        if (!this.workspace || window.Blockly.derivWorkspace.isFlyoutVisible || this.workspace.isDragging()) {
            return;
        }
        this.enforceLimitations();
    },
    customContextMenu(menu) {
        const menu_items = [localize('Enable Block'), localize('Disable Block')];
        excludeOptionFromContextMenu(menu, menu_items);
        modifyContextMenu(menu);
    },
    // Reuse the same limitation logic as all other trade_definition_* chain blocks.
    enforceLimitations: window.Blockly.Blocks.trade_definition_market.enforceLimitations,
    required_inputs: ['VH_ENABLED', 'VH_VIRTUAL_TRADES', 'VH_REAL_WINS'],
};

// Configuration is consumed by the trade_definition generator — this block
// emits no code of its own.
window.Blockly.JavaScript.javascriptGenerator.forBlock.trade_definition_virtualhook = () => {};
