// =============================================================
// VHToolbarControl — compact "Virtual Hook: [ VH Settings ]"
// control for the Bot Builder toolbar.
//
// The single source of truth for XML VH config is the
// `trade_definition_market` block's fields:
//   VH_ENABLED, VH_VIRTUAL_TRADES, VH_REAL_WINS, VH_STAKE
//
// This control is a VIEW + EDITOR over those fields. It never
// duplicates the configuration into a second store — on Apply it
// writes straight back to the block via setFieldValue, which fires
// the standard Blockly BLOCK_CHANGE event so undo / save / XML
// export all keep working unchanged.
// =============================================================

import React from 'react';
import { localize } from '@deriv-com/translations';
import VHSettingsModal, { type VHSettingsValues } from '@/components/virtual-hook/vh-settings-modal';

// Blockly is loaded as a window global by the bot-skeleton. The
// blockly package's global namespace doesn't include Deriv's
// `derivWorkspace` extension, so we access the runtime global through
// a minimal local interface — this keeps the file self-contained
// without modifying shared type declarations.
type MarketBlockLike = {
    getFieldValue: (name: string) => string | null;
    setFieldValue: (value: string, name: string) => void;
};
interface BlocklyWorkspaceLike {
    getAllBlocks?: () => MarketBlockLike[];
}
interface BlocklyGlobalLike {
    derivWorkspace?: BlocklyWorkspaceLike;
    Events?: { setGroup?: (group: string | false) => void };
}
function getBlockly(): BlocklyGlobalLike | undefined {
    return (window as unknown as { Blockly?: BlocklyGlobalLike }).Blockly;
}

/** Locate the trade_definition_market block in the active workspace. */
function findMarketBlock(): MarketBlockLike | null {
    const workspace = getBlockly()?.derivWorkspace;
    if (!workspace) return null;
    const all_blocks: MarketBlockLike[] =
        (workspace.getAllBlocks?.() as MarketBlockLike[] | undefined) ?? [];
    return all_blocks.find(b => (b as { type?: string }).type === 'trade_definition_market') ?? null;
}

function readVHValues(): VHSettingsValues | null {
    const block = findMarketBlock();
    if (!block) return null;
    const enabledStr = block.getFieldValue('VH_ENABLED') ?? 'FALSE';
    const maxSteps = parseInt(block.getFieldValue('VH_VIRTUAL_TRADES') ?? '5', 10) || 5;
    const minWins = parseInt(block.getFieldValue('VH_REAL_WINS') ?? '3', 10) || 3;
    const stake = parseFloat(block.getFieldValue('VH_STAKE') ?? '1') || 1;
    return {
        enabled: enabledStr === 'TRUE',
        maxSteps,
        minWins: Math.min(minWins, maxSteps),
        virtualStake: stake,
    };
}

function writeVHValues(values: VHSettingsValues): void {
    const block = findMarketBlock();
    if (!block) return;
    // Group the field writes as one logical change so a single Undo
    // step reverts the whole VH settings edit at once.
    const blockly = getBlockly();
    blockly?.Events?.setGroup?.('vh_settings_apply');
    try {
        block.setFieldValue(values.enabled ? 'TRUE' : 'FALSE', 'VH_ENABLED');
        block.setFieldValue(String(values.maxSteps), 'VH_VIRTUAL_TRADES');
        block.setFieldValue(String(values.minWins), 'VH_REAL_WINS');
        block.setFieldValue(String(values.virtualStake), 'VH_STAKE');
    } finally {
        blockly?.Events?.setGroup?.('');
    }
}

const VHToolbarControl: React.FC = () => {
    const [open, setOpen] = React.useState(false);
    const [version, setVersion] = React.useState(0);
    const [current, setCurrent] = React.useState<VHSettingsValues | null>(null);

    // Refresh from the workspace on mount and whenever the modal opens.
    // The workspace may mount slightly after the toolbar, so retry once
    // after a short delay as a safety net.
    const refresh = React.useCallback(() => {
        setCurrent(readVHValues());
        setVersion(v => v + 1);
    }, []);

    React.useEffect(() => {
        refresh();
        const t = setTimeout(refresh, 500);
        return () => clearTimeout(t);
    }, [refresh]);

    const handleOpen = () => {
        refresh();
        setOpen(true);
    };

    const handleApply = (next: VHSettingsValues) => {
        writeVHValues(next);
        setCurrent(next);
        setVersion(v => v + 1);
        setOpen(false);
    };

    const blockExists = current !== null;
    const isOn = current?.enabled ?? false;

    return (
        <>
            <div className='toolbar__vh-control' data-testid='dt_toolbar_vh_control'>
                <span className='toolbar__vh-label'>{localize('Virtual Hook:')}</span>
                <span
                    className={`toolbar__vh-status ${isOn ? 'toolbar__vh-status--on' : 'toolbar__vh-status--off'}`}
                    title={blockExists ? (isOn ? localize('VH enabled') : localize('VH disabled')) : localize('Add a Trade parameters block first')}
                >
                    {isOn ? localize('ON') : localize('OFF')}
                </span>
                <button
                    type='button'
                    id='db-toolbar__vh-settings-button'
                    className='toolbar__btn toolbar__btn--vh-settings'
                    onClick={handleOpen}
                    disabled={!blockExists}
                    title={blockExists ? localize('Open Virtual Hook settings') : localize('Add a Trade parameters block first')}
                >
                    {localize('VH Settings')}
                </button>
            </div>

            <VHSettingsModal
                is_visible={open}
                onClose={() => setOpen(false)}
                onApply={handleApply}
                values={
                    current ?? {
                        enabled: false,
                        maxSteps: 5,
                        minWins: 3,
                        virtualStake: 1,
                    }
                }
                // XML bot reads these fields at code-generation time (on Run),
                // so editing them mid-run would not take effect until the next
                // run. Keep the controls enabled so the user can pre-configure;
                // the values apply on the next start.
                numbers_disabled={false}
                toggle_disabled={false}
                is_dark={false}
            />
            {/* version is read here so the lint never flags it as unused and
                so re-renders are deterministic after refresh(). */}
            <span hidden>{version}</span>
        </>
    );
};

export default VHToolbarControl;
