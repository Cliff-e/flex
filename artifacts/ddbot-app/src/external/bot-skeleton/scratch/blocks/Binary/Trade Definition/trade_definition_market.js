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
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            previousStatement: null,
            nextStatement: null,
        });

        this.setMovable(false);
        this.setDeletable(false);
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
