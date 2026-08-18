// =============================================================
// VHSettingsModal — the single Virtual Hook settings window.
//
// This is a CONTROL SURFACE ONLY. It never owns VH state — the
// caller passes the existing VH configuration in `values` and
// receives the drafted result via `onApply`. Each surface (AI Bots
// page React state, Bot Builder Blockly market-block fields) keeps
// its own single source of truth; the modal edits a draft and
// commits it back.
//
// Built on the application's canonical shared_ui Dialog so it reuses
// the existing modal system (portal, overlay, close icon, ESC).
// =============================================================

import React from 'react';
import Dialog from '@/components/shared_ui/dialog';
import { localize } from '@deriv-com/translations';

export interface VHSettingsValues {
    enabled: boolean;
    maxSteps: number;
    minWins: number;
    virtualStake: number;
}

interface TVHSettingsModal {
    is_visible: boolean;
    onClose: () => void;
    onApply: (values: VHSettingsValues) => void;
    values: VHSettingsValues;
    /** Disable numeric edits (e.g. while a bot session is running). */
    numbers_disabled?: boolean;
    /** Disable the enable/disable toggle (e.g. while executing/recovering). */
    toggle_disabled?: boolean;
    is_dark?: boolean;
}

const MAX_STEPS_LIMIT = 50;

const VHSettingsModal: React.FC<TVHSettingsModal> = ({
    is_visible,
    onClose,
    onApply,
    values,
    numbers_disabled = false,
    toggle_disabled = false,
    is_dark = false,
}) => {
    const [draft, setDraft] = React.useState<VHSettingsValues>(values);

    // Re-seed the draft from the authoritative config every time the
    // modal opens, so reopening shows current values (no stale draft).
    React.useEffect(() => {
        if (is_visible) setDraft(values);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [is_visible]);

    const setEnabled = (v: boolean) => setDraft(d => ({ ...d, enabled: v }));

    const setMaxSteps = (v: number) => {
        const n = Math.max(1, Math.min(MAX_STEPS_LIMIT, Math.floor(Number(v)) || 1));
        setDraft(d => {
            // minWins can never exceed maxSteps (VHConfig invariant).
            const minWins = Math.min(d.minWins, n);
            return { ...d, maxSteps: n, minWins };
        });
    };

    const setMinWins = (v: number) => {
        setDraft(d => {
            const n = Math.max(1, Math.min(d.maxSteps, Math.floor(Number(v)) || 1));
            return { ...d, minWins: n };
        });
    };

    const setStake = (v: number) => {
        const n = Math.max(0.35, Number(v) || 0.35);
        setDraft(d => ({ ...d, virtualStake: n }));
    };

    const handleApply = () => onApply(draft);

    const labelStyle: React.CSSProperties = {
        fontSize: 11,
        fontWeight: 700,
        color: is_dark ? '#c084fc' : '#5b21b6',
        textTransform: 'uppercase',
        letterSpacing: 1,
    };
    const hintStyle: React.CSSProperties = {
        fontSize: 10,
        color: is_dark ? '#888' : '#777',
        marginTop: 2,
    };
    const cardStyle: React.CSSProperties = {
        border: '1px solid ' + (is_dark ? '#2a1a4a' : '#d0c0f0'),
        borderRadius: 8,
        padding: '10px 12px',
        background: is_dark ? '#0d0d1a' : '#f5f0ff',
    };
    const stepperBtnStyle = (disabled: boolean): React.CSSProperties => ({
        width: 28,
        height: 28,
        borderRadius: 6,
        border: '1px solid ' + (is_dark ? '#333' : '#ccc'),
        background: disabled ? (is_dark ? '#111' : '#eee') : is_dark ? '#1a1a2a' : '#fff',
        color: disabled ? '#555' : is_dark ? '#c084fc' : '#5b21b6',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 16,
        fontWeight: 700,
        opacity: disabled ? 0.5 : 1,
    });
    const valueStyle: React.CSSProperties = {
        minWidth: 48,
        textAlign: 'center',
        fontFamily: 'monospace',
        fontSize: 14,
        fontWeight: 700,
        color: is_dark ? '#fff' : '#111',
    };
    const toggleBtnStyle = (on: boolean, disabled: boolean): React.CSSProperties => ({
        minWidth: 76,
        padding: '5px 14px',
        borderRadius: 20,
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'monospace',
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: 1,
        background: on ? '#c084fc' : is_dark ? '#222' : '#e8edf3',
        color: on ? '#000' : is_dark ? '#888' : '#555',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.2s',
    });

    return (
        <Dialog
            portal_element_id='modal_root'
            title={localize('Virtual Hook')}
            is_visible={is_visible}
            onConfirm={handleApply}
            onCancel={onClose}
            confirm_button_text={localize('Apply Settings')}
            cancel_button_text={localize('Cancel')}
            // The Dialog type marks `login` as required, but it is only
            // invoked when cancel_button_text === 'Log in' — a no-op
            // keeps this modal self-contained without modifying the
            // shared Dialog component.
            login={() => {}}
            is_closed_on_cancel
            is_closed_on_confirm
            has_close_icon
            is_mobile_full_width={false}
            className='vh-settings-dialog'
        >
            <div
                className='vh-settings'
                style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>⚡</span>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: is_dark ? '#fff' : '#111' }}>
                            {localize('Virtual Hook')}
                        </span>
                        <span style={{ fontSize: 10, color: is_dark ? '#888' : '#777' }}>
                            {localize('Protect your balance with virtual trades.')}
                        </span>
                    </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={labelStyle}>{localize('Virtual Hook')}</span>
                    <button
                        type='button'
                        onClick={() => setEnabled(!draft.enabled)}
                        disabled={toggle_disabled}
                        style={toggleBtnStyle(draft.enabled, toggle_disabled)}
                    >
                        {draft.enabled ? '● ON' : '○ OFF'}
                    </button>
                </div>

                <div style={cardStyle}>
                    <div style={labelStyle}>{localize('No. of Consecutive Virtual Losses')}</div>
                    <div style={hintStyle}>
                        {localize('Virtual rounds per signal before authorizing real.')}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                        <button
                            type='button'
                            onClick={() => setMaxSteps(draft.maxSteps - 1)}
                            disabled={numbers_disabled || draft.maxSteps <= 1}
                            style={stepperBtnStyle(numbers_disabled || draft.maxSteps <= 1)}
                        >
                            −
                        </button>
                        <span style={valueStyle}>{draft.maxSteps}</span>
                        <button
                            type='button'
                            onClick={() => setMaxSteps(draft.maxSteps + 1)}
                            disabled={numbers_disabled || draft.maxSteps >= MAX_STEPS_LIMIT}
                            style={stepperBtnStyle(numbers_disabled || draft.maxSteps >= MAX_STEPS_LIMIT)}
                        >
                            +
                        </button>
                    </div>
                </div>

                <div style={cardStyle}>
                    <div style={labelStyle}>{localize('No. of Wins on Real before switching to VH')}</div>
                    <div style={hintStyle}>
                        {localize('Wins required on real trades to keep VH active.')}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                        <button
                            type='button'
                            onClick={() => setMinWins(draft.minWins - 1)}
                            disabled={numbers_disabled || draft.minWins <= 1}
                            style={stepperBtnStyle(numbers_disabled || draft.minWins <= 1)}
                        >
                            −
                        </button>
                        <span style={valueStyle}>{draft.minWins}</span>
                        <button
                            type='button'
                            onClick={() => setMinWins(draft.minWins + 1)}
                            disabled={numbers_disabled || draft.minWins >= draft.maxSteps}
                            style={stepperBtnStyle(numbers_disabled || draft.minWins >= draft.maxSteps)}
                        >
                            +
                        </button>
                    </div>
                </div>

                <div style={cardStyle}>
                    <div style={labelStyle}>{localize('Virtual Stake')}</div>
                    <div style={hintStyle}>
                        {localize('Virtual-only — never affects real trades.')}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                        <button
                            type='button'
                            onClick={() => setStake(draft.virtualStake - 0.01)}
                            disabled={numbers_disabled || draft.virtualStake <= 0.35}
                            style={stepperBtnStyle(numbers_disabled || draft.virtualStake <= 0.35)}
                        >
                            −
                        </button>
                        <span style={valueStyle}>{draft.virtualStake.toFixed(2)}</span>
                        <button
                            type='button'
                            onClick={() => setStake(draft.virtualStake + 0.01)}
                            disabled={numbers_disabled}
                            style={stepperBtnStyle(numbers_disabled)}
                        >
                            +
                        </button>
                    </div>
                </div>
            </div>
        </Dialog>
    );
};

export default VHSettingsModal;
