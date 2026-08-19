import { localize } from '@deriv-com/translations';
import ApiHelpers from '../../../../services/api/api-helpers';
import DBotStore from '../../../dbot-store';
import { excludeOptionFromContextMenu, modifyContextMenu, runIrreversibleEvents } from '../../../utils';
import { EventBus } from '@/utils/EventBus';
/* eslint-disable */
window.Blockly.Blocks.trade_definition_market = {
    init() {
        this.jsonInit({
            message0: localize('Market: {{ input_market }} > {{ input_submarket }} > {{ input_symbol }}', {
                input_market: '%1',
                input_submarket: '%2',
                input_symbol: '%3',
            }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'MARKET_LIST',
                    options: [['', '']],
                },
                {
                    type: 'field_dropdown',
                    name: 'SUBMARKET_LIST',
                    options: [['', '']],
                },
                {
                    type: 'field_dropdown',
                    name: 'SYMBOL_LIST',
                    options: [['', '']],
                },
            ],
            message1: localize('Virtual Hook: {{ enabled }} {{ vh_settings }}', {
                enabled: '%1',
                vh_settings: '%2',
            }),
            args1: [
                {
                    type: 'field_checkbox',
                    name: 'VH_ENABLED',
                    checked: false,
                    class: 'blocklyCheckbox',
                },
                {
                    type: 'field_vh_settings_button',
                    name: 'VH_SETTINGS_BTN',
                },
            ],
            message2: localize('Max Wins {{ enabled }} {{ num }}', { enabled: '%1', num: '%2' }),
            args2: [
                { type: 'field_checkbox', name: 'VH_WIN_ENABLED', checked: true },
                {
                    type: 'field_number',
                    name: 'VH_WIN_THRESHOLD',
                    value: 3,
                    min: 0,
                    precision: 1,
                },
            ],
            message3: localize('Max Losses {{ enabled }} {{ num }}', { enabled: '%1', num: '%2' }),
            args3: [
                { type: 'field_checkbox', name: 'VH_LOSS_ENABLED', checked: false },
                {
                    type: 'field_number',
                    name: 'VH_LOSS_THRESHOLD',
                    value: 3,
                    min: 0,
                    precision: 1,
                },
            ],
            message4: localize('Max VH Instances / Steps {{ enabled }} {{ num }}', { enabled: '%1', num: '%2' }),
            args4: [
                { type: 'field_checkbox', name: 'VH_STEPS_ENABLED', checked: true },
                {
                    type: 'field_number',
                    name: 'VH_VIRTUAL_TRADES',
                    value: 5,
                    min: 0,
                    precision: 1,
                },
            ],
            message5: localize('Virtual Stake {{ num }}', { num: '%1' }),
            args5: [
                {
                    type: 'field_number',
                    name: 'VH_STAKE',
                    value: 1.0,
                    min: 0,
                    precision: 0.01,
                },
            ],
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            previousStatement: null,
            nextStatement: null,
        });

        this.setMovable(false);
        this.setDeletable(false);

        // The raw VH numeric inputs remain in the block model (so
        // mutationToDom/domToMutation and code generation keep working),
        // but they are hidden from the block UI — editing happens in the
        // bundled VH Settings modal opened by the button field above.
        this.getField('VH_WIN_THRESHOLD')?.setVisible(false);
        this.getField('VH_WIN_ENABLED')?.setVisible(false);
        this.getField('VH_LOSS_THRESHOLD')?.setVisible(false);
        this.getField('VH_LOSS_ENABLED')?.setVisible(false);
        this.getField('VH_VIRTUAL_TRADES')?.setVisible(false);
        this.getField('VH_STEPS_ENABLED')?.setVisible(false);
        this.getField('VH_STAKE')?.setVisible(false);
    },
    /**
     * Serialize Virtual Hook settings into a <mutation> XML element.
     * This prevents "XML file contains unsupported elements" errors when loading
     * bots that were saved with VH settings, and ensures all four VH attributes
     * are persisted even if Blockly's standard field serialization changes.
     *
     * Saved attributes: vh_enabled, vh_win_threshold, vh_win_enabled,
     * vh_loss_threshold, vh_loss_enabled, vh_max_steps, vh_steps_enabled,
     * vh_stake
     */
    mutationToDom() {
        const container = document.createElement('mutation');
        container.setAttribute('vh_enabled',   this.getFieldValue('VH_ENABLED') ?? 'FALSE');
        container.setAttribute('vh_win_threshold', this.getFieldValue('VH_WIN_THRESHOLD') ?? '3');
        container.setAttribute('vh_win_enabled', this.getFieldValue('VH_WIN_ENABLED') ?? 'TRUE');
        container.setAttribute('vh_loss_threshold', this.getFieldValue('VH_LOSS_THRESHOLD') ?? '3');
        container.setAttribute('vh_loss_enabled', this.getFieldValue('VH_LOSS_ENABLED') ?? 'FALSE');
        container.setAttribute('vh_max_steps', this.getFieldValue('VH_VIRTUAL_TRADES') ?? '5');
        container.setAttribute('vh_steps_enabled', this.getFieldValue('VH_STEPS_ENABLED') ?? 'TRUE');
        container.setAttribute('vh_stake',     this.getFieldValue('VH_STAKE') ?? '1');
        return container;
    },
    /**
     * Restore Virtual Hook settings from a <mutation> XML element.
     * Older XML used vh_min_wins; that value is migrated to the win threshold.
     */
    domToMutation(xmlElement) {
        const getBool = attr =>
            xmlElement.getAttribute(attr)?.toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE';
        const getNum  = (attr, fallback) => {
            const v = parseFloat(xmlElement.getAttribute(attr));
            return isNaN(v) ? fallback : String(v);
        };

        const enabled   = getBool('vh_enabled');
        const win_threshold = getNum('vh_win_threshold', getNum('vh_min_wins', '3'));
        const win_enabled = getBool('vh_win_enabled');
        const loss_threshold = getNum('vh_loss_threshold', '3');
        const loss_enabled = getBool('vh_loss_enabled');
        const max_steps = getNum('vh_max_steps', '5');
        const steps_enabled = getBool('vh_steps_enabled');
        const stake     = getNum('vh_stake',     '1');

        this.getField('VH_ENABLED')?.setValue(enabled);
        this.getField('VH_WIN_THRESHOLD')?.setValue(win_threshold);
        this.getField('VH_WIN_ENABLED')?.setValue(win_enabled);
        this.getField('VH_LOSS_THRESHOLD')?.setValue(loss_threshold);
        this.getField('VH_LOSS_ENABLED')?.setValue(loss_enabled);
        this.getField('VH_VIRTUAL_TRADES')?.setValue(max_steps);
        this.getField('VH_STEPS_ENABLED')?.setValue(steps_enabled);
        this.getField('VH_STAKE')?.setValue(stake);
    },
    customContextMenu(menu) {
        const menu_items = [localize('Enable Block'), localize('Disable Block')];
        excludeOptionFromContextMenu(menu, menu_items);
        modifyContextMenu(menu);
    },
    onchange(event) {
        const allowed_events = ['BLOCK_CREATE', 'BLOCK_CHANGE', 'BLOCK_DRAG'];
        const is_allowed_event =
            allowed_events.findIndex(event_name => event.type === window.Blockly.Events[event_name]) !== -1;

        if (
            !this.workspace ||
            window.Blockly.derivWorkspace.isFlyoutVisible ||
            this.workspace.isDragging() ||
            !is_allowed_event
        ) {
            return;
        }

        this.enforceLimitations();

        const { active_symbols } = ApiHelpers?.instance ?? {};
        if (!active_symbols) return;

        const market_dropdown = this.getField('MARKET_LIST');
        const submarket_dropdown = this.getField('SUBMARKET_LIST');
        const symbol_dropdown = this.getField('SYMBOL_LIST');
        const market = market_dropdown.getValue();
        const submarket = submarket_dropdown.getValue();
        const symbol = symbol_dropdown.getValue();

        const market_options = active_symbols.getMarketDropdownOptions();

        // When symbols load after a bot is already in the workspace (guest/preview mode),
        // Blockly's FieldDropdown.setValue() will have rejected the XML-loaded values
        // (e.g. '1HZ30V') because the placeholder [['','']] options didn't include them.
        // The fromXml patch in field.js saves the raw XML value as _intended_value before
        // validation strips it. We use that here as a fallback so the cascade restores
        // the correct selection even when getValue() returns '' or the literal string
        // 'undefined' (written by bots saved while this bug was present).
        const effectiveValue = (current, field) => {
            if (current && current !== 'undefined') return current;
            const intended = field._intended_value;
            return (intended && intended !== 'undefined') ? intended : '';
        };

        const populateMarketDropdown = () => {
            market_dropdown?.updateOptions(market_options, {
                default_value: effectiveValue(market, market_dropdown),
                should_pretend_empty: true,
                event_group: event.group,
            });
        };

        if (event.type === window.Blockly.Events.BLOCK_CREATE && event.ids.includes(this.id)) {
            // If processed_symbols is empty (symbols still loading), defer repopulation
            // until active_symbols:loaded fires and processed_symbols is ready.
            // _intended_value is already saved on each field by the fromXml patch so we
            // don't need to capture anything here — the cascade reads it when it runs.
            if (!Object.keys(active_symbols.processed_symbols ?? {}).length) {
                const blockId = this.id;
                const unsub = EventBus.on('active_symbols:loaded', async () => {
                    unsub();
                    try {
                        await active_symbols.retrieveActiveSymbols();
                        const ws = window.Blockly?.derivWorkspace;
                        if (!ws) return;
                        const blk = ws.getBlockById(blockId);
                        if (!blk) return;
                        // Fire BlockCreate so onchange runs again. This time processed_symbols
                        // is populated and the cascade uses effectiveValue/_intended_value to
                        // restore the correct market/submarket/symbol selection.
                        runIrreversibleEvents(() => {
                            window.Blockly.Events.fire(new window.Blockly.Events.BlockCreate(blk));
                        });
                    } catch (_) {}
                });
                return;
            }
            populateMarketDropdown();
        } else if (event.type === window.Blockly.Events.BLOCK_CHANGE && event.blockId === this.id) {
            if (event.name === 'MARKET_LIST') {
                // market was just set correctly by populateMarketDropdown; submarket may
                // still be '' (validation-rejected) — use _intended_value as fallback.
                submarket_dropdown.updateOptions(active_symbols.getSubmarketDropdownOptions(market), {
                    default_value: effectiveValue(submarket, submarket_dropdown),
                    should_pretend_empty: true,
                    event_group: event.group,
                });
            } else if (event.name === 'SUBMARKET_LIST') {
                // submarket was just set; symbol may still be '' — use _intended_value.
                symbol_dropdown.updateOptions(active_symbols.getSymbolDropdownOptions(submarket), {
                    default_value: effectiveValue(symbol, symbol_dropdown),
                    should_pretend_empty: true,
                    event_group: event.group,
                });
            } else if (event.name === 'SYMBOL_LIST') {
                const new_symbol = symbol_dropdown.getValue();
                DBotStore.instance.dashboard.setBotBuilderSymbol(new_symbol);
            }
        } else if (
            event.type === window.Blockly.Events.BLOCK_DRAG &&
            !event.isStart &&
            event.blockId === this.getRootBlock().id
        ) {
            if (market_dropdown.isEmpty() || submarket_dropdown.isEmpty() || symbol_dropdown.isEmpty()) {
                populateMarketDropdown();
            }
        }
    },
    enforceLimitations() {
        runIrreversibleEvents(() => {
            if (!this.isDescendantOf('trade_definition')) {
                this.unplug(false); // Unplug without reconnecting siblings

                const top_blocks = this.workspace.getTopBlocks();
                const trade_definition_block = top_blocks.find(block => block.type === 'trade_definition');

                // Reconnect self to trade definition block.
                if (trade_definition_block) {
                    const connection = trade_definition_block.getLastConnectionInStatement('TRADE_OPTIONS');
                    if (connection) {
                        connection.connect(this.previousConnection);
                    }
                } else {
                    this.dispose();
                }
            }
            // These blocks cannot be disabled.
            else if (this.disabled) {
                this.setDisabled(false);
            }
        });
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.trade_definition_market = () => {};
