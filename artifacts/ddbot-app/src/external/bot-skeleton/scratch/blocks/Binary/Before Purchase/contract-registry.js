/**
 * @file contract-registry.js
 *
 * Single source of truth for every purchasable contract type.
 *
 * Import from this file in every Purchase-related block and in the
 * Contract Type Switcher.  To support a new contract type in the future,
 * add one entry here — no other block file needs to change.
 *
 * The registry is intentionally independent of Trade Parameters.
 * Blocks that use it will never show "Not Available" or a filtered subset.
 */

/**
 * Sentinel value emitted by Purchase / Purchase (Advanced) blocks when
 * the user selects "Disable (Use Runtime)".  The runtime interprets this
 * as "do not override — use the Contract Changer or Trade Parameters value."
 *
 * Priority at runtime:
 *   1. Contract selected on the Purchase block  (if ≠ DISABLE)
 *   2. Contract Type Switcher  (activeContractOverride)
 *   3. Trade Parameters  (contractTypes[0])
 */
export const PURCHASE_DISABLE = 'DISABLE';

/**
 * Full ordered list of every purchasable contract type.
 *
 * Format: [displayLabel, contractCode]
 *
 * DISABLE must remain first so that an invalid or legacy value loaded from
 * XML (e.g. "NOT_AVAILABLE" or "") falls back to it when Blockly picks the
 * nearest valid option.
 */
export const ALL_CONTRACT_TYPE_OPTIONS = [
    // ── Disable: defer to Contract Changer / Trade Parameters ─────────────
    ['Disable (Use Runtime)',   'DISABLE'],
    // ── Up / Down ──────────────────────────────────────────────────────────
    ['Rise',                    'CALL'],
    ['Fall',                    'PUT'],
    ['Higher',                  'CALLE'],
    ['Lower',                   'PUTE'],
    // ── Digits ────────────────────────────────────────────────────────────
    ['Even',                    'DIGITEVEN'],
    ['Odd',                     'DIGITODD'],
    ['Matches',                 'DIGITMATCH'],
    ['Differs',                 'DIGITDIFF'],
    ['Over',                    'DIGITOVER'],
    ['Under',                   'DIGITUNDER'],
    // ── Touch ─────────────────────────────────────────────────────────────
    ['Touch',                   'ONETOUCH'],
    ['No Touch',                'NOTOUCH'],
    // ── Ends ──────────────────────────────────────────────────────────────
    ['Ends Between',            'EXPIRYRANGE'],
    ['Ends Outside',            'EXPIRYMISS'],
    // ── Asian ─────────────────────────────────────────────────────────────
    ['Asian Up',                'ASIANU'],
    ['Asian Down',              'ASIAND'],
    // ── Reset ─────────────────────────────────────────────────────────────
    ['Reset Call',              'RESETCALL'],
    ['Reset Put',               'RESETPUT'],
    // ── Run ───────────────────────────────────────────────────────────────
    ['Only Ups',                'RUNHIGH'],
    ['Only Downs',              'RUNLOW'],
    // ── Spread ────────────────────────────────────────────────────────────
    ['Call Spread',             'CALLSPREAD'],
    ['Put Spread',              'PUTSPREAD'],
];

/**
 * ALL_CONTRACT_TYPE_OPTIONS without the DISABLE sentinel.
 * Use for blocks where "use runtime" is not a valid selection
 * (e.g. Ask Price, Payout).
 */
export const CONTRACT_TYPE_OPTIONS_NO_DISABLE = ALL_CONTRACT_TYPE_OPTIONS.filter(
    ([, value]) => value !== PURCHASE_DISABLE
);
