// =============================================================
// FieldVHSettingsButton — a clickable "VH Settings" label field
// rendered inside the trade_definition_market (Trade parameters)
// block, next to the VH_ENABLED checkbox.
//
// The field is a pure CONTROL SURFACE: it holds no state and is
// never serialized into saved bot XML. Clicking it emits the
// 'vh:open-settings' EventBus event, which the React-side
// VHSettingsHost listens for to open the single bundled VH
// settings modal (draft-state + Apply/Cancel semantics).
//
// Blockly is loaded as a window global (v10.4.3) by the bot-skeleton.
// =============================================================

import { localize } from '@deriv-com/translations';
import { EventBus } from '@/utils/EventBus';

class FieldVHSettingsButton extends window.Blockly.FieldLabel {
    constructor() {
        super(localize('VH Settings'), 'field-vh-settings-button');
        // Never persisted — the button carries no configuration.
        this.SERIALIZABLE = false;
    }

    static fromJson(_options) {
        return new FieldVHSettingsButton();
    }

    initView() {
        super.initView();
        const el = this.getSvgRoot();
        if (!el) return;
        el.style.cursor = 'pointer';
        // Stop Blockly's gesture/drag system from picking up the
        // pointerdown on this field so clicking never drags the block.
        el.addEventListener('pointerdown', e => {
            e.stopPropagation();
        });
        el.addEventListener('click', e => {
            e.stopPropagation();
            EventBus.emit('vh:open-settings');
        });
    }
}

window.Blockly.fieldRegistry.register('field_vh_settings_button', FieldVHSettingsButton);
