// =============================================================
// VH block bridge — read/write helpers for the Virtual Hook
// configuration stored on the `trade_definition_market` block.
//
// The single source of truth for XML VH config is the
// `trade_definition_market` block's fields:
//   VH_ENABLED, VH_WIN_THRESHOLD, VH_LOSS_THRESHOLD, VH_VIRTUAL_TRADES,
//   VH_WIN_ENABLED, VH_LOSS_ENABLED, VH_STEPS_ENABLED, VH_STAKE
//
// Consumers (e.g. VHSettingsHost) are a VIEW + EDITOR over those
// fields. They never duplicate the configuration into a second
// store — on Apply the values are written straight back to the
// block via setFieldValue, which fires the standard Blockly
// BLOCK_CHANGE event so undo / save / XML export all keep working
// unchanged.
// =============================================================

import type { VHSettingsValues } from '@/components/virtual-hook/vh-settings-modal';

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
export function findMarketBlock(): MarketBlockLike | null {
    const workspace = getBlockly()?.derivWorkspace;
    if (!workspace) return null;
    const all_blocks: MarketBlockLike[] =
        (workspace.getAllBlocks?.() as MarketBlockLike[] | undefined) ?? [];
    return all_blocks.find(b => (b as { type?: string }).type === 'trade_definition_market') ?? null;
}

export function readVHValues(): VHSettingsValues | null {
    const block = findMarketBlock();
    if (!block) return null;
    const enabledStr = block.getFieldValue('VH_ENABLED') ?? 'FALSE';
    const winThreshold = parseInt(block.getFieldValue('VH_WIN_THRESHOLD') ?? '3', 10) || 0;
    const lossThreshold = parseInt(block.getFieldValue('VH_LOSS_THRESHOLD') ?? '3', 10) || 0;
    const maxSteps = parseInt(block.getFieldValue('VH_VIRTUAL_TRADES') ?? '5', 10) || 0;
    const stake = parseFloat(block.getFieldValue('VH_STAKE') ?? '1') || 1;
    return {
        enabled: enabledStr === 'TRUE',
        winThreshold,
        winThresholdEnabled: (block.getFieldValue('VH_WIN_ENABLED') ?? 'TRUE') === 'TRUE',
        lossThreshold,
        lossThresholdEnabled: (block.getFieldValue('VH_LOSS_ENABLED') ?? 'FALSE') === 'TRUE',
        maxSteps,
        maxStepsEnabled: (block.getFieldValue('VH_STEPS_ENABLED') ?? 'TRUE') === 'TRUE',
        virtualStake: stake,
    };
}

export function writeVHValues(values: VHSettingsValues): void {
    const block = findMarketBlock();
    if (!block) return;
    // Group the field writes as one logical change so a single Undo
    // step reverts the whole VH settings edit at once.
    const blockly = getBlockly();
    blockly?.Events?.setGroup?.('vh_settings_apply');
    try {
        block.setFieldValue(values.enabled ? 'TRUE' : 'FALSE', 'VH_ENABLED');
        block.setFieldValue(String(values.winThreshold), 'VH_WIN_THRESHOLD');
        block.setFieldValue(values.winThresholdEnabled ? 'TRUE' : 'FALSE', 'VH_WIN_ENABLED');
        block.setFieldValue(String(values.lossThreshold), 'VH_LOSS_THRESHOLD');
        block.setFieldValue(values.lossThresholdEnabled ? 'TRUE' : 'FALSE', 'VH_LOSS_ENABLED');
        block.setFieldValue(String(values.maxSteps), 'VH_VIRTUAL_TRADES');
        block.setFieldValue(values.maxStepsEnabled ? 'TRUE' : 'FALSE', 'VH_STEPS_ENABLED');
        block.setFieldValue(String(values.virtualStake), 'VH_STAKE');
    } finally {
        blockly?.Events?.setGroup?.('');
    }
}
