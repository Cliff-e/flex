import { localize } from '@deriv-com/translations';
import { excludeOptionFromContextMenu, modifyContextMenu } from '../../../utils';

/**
 * Sentinel value used when the Purchase block should not override the contract.
 * The runtime defers to the Contract Changer override or Trade Parameters.
 */
export const PURCHASE_DISABLE = 'DISABLE';

/**
 * Full static list of every purchasable contract type, including the special
 * "Disable" entry that tells the runtime to use whatever contract is currently
 * active from Trade Parameters or the Contract Changer block.
 *
 * This intentionally does NOT depend on Trade Parameters — the user can
 * pick any type here and combine it with Symbol Controls / Contract Type
 * Switcher to build cross-type strategies (e.g. recover Vol 10 DIGITOVER
 * losses with Vol 75 1s DIGITEVEN).
 *
 * Exported so other blocks (purchase_all_contracts, toolbox) can reuse it.
 *
 * To add a future contract type, append one entry here — no other file needs
 * to change for the block itself.
 */
export const ALL_CONTRACT_TYPE_OPTIONS = [
    // ── Disable: defer to Trade Parameters / Contract Changer ─────────────────
    ['Disable (use Trade Parameters)',  'DISABLE'],
    // ── Up / Down ─────────────────────────────────────────────────────────────
    ['Rise (Call)',                     'CALL'],
    ['Fall (Put)',                      'PUT'],
    ['Higher',                          'CALLE'],
    ['Lower',                           'PUTE'],
    // ── Digits ────────────────────────────────────────────────────────────────
    ['Even',                            'DIGITEVEN'],
    ['Odd',                             'DIGITODD'],
    ['Matches',                         'DIGITMATCH'],
    ['Differs',                         'DIGITDIFF'],
    ['Over',                            'DIGITOVER'],
    ['Under',                           'DIGITUNDER'],
    // ── Touch ─────────────────────────────────────────────────────────────────
    ['Touch',                           'ONETOUCH'],
    ['No Touch',                        'NOTOUCH'],
    // ── Ends ──────────────────────────────────────────────────────────────────
    ['Ends Between',                    'EXPIRYRANGE'],
    ['Ends Outside',                    'EXPIRYMISS'],
    // ── Asian ─────────────────────────────────────────────────────────────────
    ['Asian Up',                        'ASIANU'],
    ['Asian Down',                      'ASIAND'],
    // ── Reset ─────────────────────────────────────────────────────────────────
    ['Reset Call',                      'RESETCALL'],
    ['Reset Put',                       'RESETPUT'],
    // ── Run ───────────────────────────────────────────────────────────────────
    ['Only Ups',                        'RUNHIGH'],
    ['Only Downs',                      'RUNLOW'],
    // ── Spread ────────────────────────────────────────────────────────────────
    ['Call Spread',                     'CALLSPREAD'],
    ['Put Spread',                      'PUTSPREAD'],
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
                'Purchase a contract. Select "Disable" to use whatever contract is active in ' +
                'Trade Parameters or the Contract Changer block. Select any other type to ' +
                'override the contract for this purchase only — Trade Parameters is not changed. ' +
                'Every supported contract type is always available regardless of Trade Parameters.'
            ),
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Purchase'),
            description: localize(
                'Purchases a contract. "Disable" uses the active contract from Trade Parameters ' +
                'or the Contract Changer block. Any other selection overrides the contract type ' +
                'for this purchase only without changing Trade Parameters. The full contract list ' +
                '(Rise, Fall, Higher, Lower, Even, Odd, Matches, Differs, Over, Under, Touch, ' +
                'No Touch, Ends Between, Ends Outside, Asian Up, Asian Down, Reset Call, Reset Put, ' +
                'Only Ups, Only Downs, Call Spread, Put Spread) is always available regardless of ' +
                'what is configured in Trade Parameters.'
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
