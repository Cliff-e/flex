// =============================================================
// VHSettingsHost — invisible React host for the Bot Builder
// surface of the single bundled VH settings dialog.
//
// The Blockly-side FieldVHSettingsButton (inside the Trade
// parameters block) emits EventBus 'vh:open-settings'. This host
// listens for that event and opens VHSettingsModal with the
// CURRENT block values; on Apply it writes the draft straight
// back to the block fields (single undo group). It renders
// nothing visible of its own — no toolbar control, no second
// config store.
// =============================================================

import React from 'react';
import { EventBus } from '@/utils/EventBus';
import VHSettingsModal, { type VHSettingsValues } from '@/components/virtual-hook/vh-settings-modal';
import { readVHValues, writeVHValues } from '@/components/virtual-hook/vh-block-bridge';

const DEFAULT_VALUES: VHSettingsValues = {
    enabled: false,
    winThreshold: 3,
    winThresholdEnabled: true,
    lossThreshold: 3,
    lossThresholdEnabled: false,
    maxSteps: 5,
    maxStepsEnabled: true,
    virtualStake: 1,
};

const VHSettingsHost: React.FC = () => {
    const [open, setOpen] = React.useState(false);
    const [values, setValues] = React.useState<VHSettingsValues>(DEFAULT_VALUES);

    React.useEffect(() => {
        const unsubscribe = EventBus.on('vh:open-settings', () => {
            // Re-read the authoritative block values every time the
            // modal is requested so the draft is never stale.
            setValues(readVHValues() ?? DEFAULT_VALUES);
            setOpen(true);
        });
        return unsubscribe;
    }, []);

    const handleApply = React.useCallback((next: VHSettingsValues) => {
        writeVHValues(next);
        setValues(next);
        setOpen(false);
    }, []);

    return (
        <VHSettingsModal
            is_visible={open}
            onClose={() => setOpen(false)}
            onApply={handleApply}
            values={values}
            // XML bots read these fields at code-generation time (on Run),
            // so editing them mid-run would not take effect until the next
            // run. Keep the controls enabled so the user can pre-configure;
            // the values apply on the next start.
            numbers_disabled={false}
            toggle_disabled={false}
            is_dark={false}
        />
    );
};

export default VHSettingsHost;
