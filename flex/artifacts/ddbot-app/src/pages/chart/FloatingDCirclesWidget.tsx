/**
 * FloatingDCirclesWidget
 *
 * Wraps the DCircles digit panel in a draggable, resizable floating overlay
 * anchored inside the SmartCharts container.
 *
 * Behaviour:
 *  - Draggable from any empty area of the panel (not just a title bar) —
 *    interactive children (inputs/buttons) opt out via `cancel`.
 *  - Resizable from all 8 edges/corners.
 *  - The panel is a "window" onto a fixed-size design canvas (DESIGN_W x
 *    DESIGN_H). Resizing the window never reflows/crops that canvas — it is
 *    scaled as a single GPU-accelerated `transform: scale(...)` unit, so
 *    circles, text, icons, spacing and connectors all grow/shrink together
 *    and the full visualization is always visible.
 *  - Constrained to the parent container bounds (bounds='parent' also caps
 *    growth at "nearly full screen" without a hardcoded max).
 *  - Position and size persisted to localStorage (scale is derived from
 *    size, so it is implicitly restored too).
 *  - Pointer-events on SmartChart wrapper are disabled while dragging,
 *    re-enabled immediately on drag stop.
 *  - No unnecessary re-renders: memo-wrapped; digit state kept local; scale
 *    is only recomputed from Rnd's own drag/resize callbacks (no extra
 *    ResizeObserver/rAF polling loop).
 */
import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import DigitCircles from '../d-circles/DigitCircles';
import { globalTickEngine } from '../../bot/globalTickEngine';

// ── localStorage keys ─────────────────────────────────────────────────────────
// Separate keys per device type so a position/size saved on desktop never
// carries over (and ends up off-centre or clipped) on a mobile viewport.
const posKeyFor  = (isMobile: boolean) => (isMobile ? 'dcircles_float_pos_mobile' : 'dcircles_float_pos');
const sizeKeyFor = (isMobile: boolean) => (isMobile ? 'dcircles_float_size_mobile' : 'dcircles_float_size');

const DISPLAY_COUNT_MAX = 5000;

// ── design canvas ─────────────────────────────────────────────────────────────
// This is the "natural" unscaled size of the panel's content. The resizable
// window is a viewport onto this canvas; it is never reflowed, only scaled.
const DESIGN_W = 380;
const DESIGN_H = 290;

// ── initial window size (before any user resize) ─────────────────────────────
const DEFAULT_W = 380;
const DEFAULT_H = 290;
const DEFAULT_W_MOBILE = 260;
const DEFAULT_H_MOBILE = 210;

// ── size constraints ──────────────────────────────────────────────────────────
const MIN_W = 200;
const MIN_H = 150;
const MIN_SCALE = 0.4;

const computeScale = (w: number, h: number) =>
    Math.max(MIN_SCALE, Math.min(w / DESIGN_W, h / DESIGN_H));

interface Props {
    symbol: string;
    isMobile: boolean;
}

const FloatingDCirclesWidget = memo(({ symbol, isMobile }: Props) => {
    // ── ref to the absolute-fill sentinel used as Rnd's bounds parent ─────────
    const sentinelRef = useRef<HTMLDivElement>(null);

    // ── persisted size (device-specific key) ─────────────────────────────────
    const [size, setSize] = useState<{ width: number; height: number }>(() => {
        try {
            const raw = localStorage.getItem(sizeKeyFor(isMobile));
            if (raw) {
                const parsed = JSON.parse(raw) as { width: number; height: number };
                if (
                    typeof parsed.width === 'number' &&
                    typeof parsed.height === 'number'
                ) return parsed;
            }
        } catch { /* ignore */ }
        return isMobile
            ? { width: DEFAULT_W_MOBILE, height: DEFAULT_H_MOBILE }
            : { width: DEFAULT_W, height: DEFAULT_H };
    });

    // ── live scale: content canvas is scaled as one unit to fill the window ──
    const [scale, setScale] = useState(() => computeScale(size.width, size.height));

    // ── persisted position (device-specific key); {x:-1,y:-1} = "compute from
    // parent on mount" ────────────────────────────────────────────────────────
    const [position, setPosition] = useState<{ x: number; y: number }>(() => {
        try {
            const raw = localStorage.getItem(posKeyFor(isMobile));
            if (raw) {
                const parsed = JSON.parse(raw) as { x: number; y: number };
                if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
                    return parsed;
                }
            }
        } catch { /* ignore */ }
        return { x: -1, y: -1 };
    });

    // ── digit state (mirrors DCirclesPanel) ───────────────────────────────────
    const [digits, setDigits] = useState<number[]>(() => {
        try {
            const saved = localStorage.getItem('digitsMap');
            if (saved) {
                const map = JSON.parse(saved) as Record<string, number[]>;
                const s = localStorage.getItem('dc_symbol') || 'R_75';
                return map[s] ?? [];
            }
        } catch { /* ignore */ }
        return [];
    });

    const [displayCount, setDisplayCount] = useState<number>(() =>
        globalTickEngine.getLimit()
    );

    const [inputValue, setInputValue] = useState<string>(() =>
        String(globalTickEngine.getLimit())
    );
    const [isEditing, setIsEditing] = useState(false);

    const visibleDigits = digits.slice(-displayCount);

    // ── subscribe to tick engine ──────────────────────────────────────────────
    useEffect(() => {
        setDigits(globalTickEngine.getDigits(symbol));
        const unsub = globalTickEngine.subscribe((sym: string, d: number[]) => {
            if (sym === symbol) setDigits(d);
        });
        return unsub;
    }, [symbol]);

    // Keep displayCount in sync when another consumer changes the engine limit
    useEffect(() => {
        const unsub = globalTickEngine.onLimitChange(n => {
            setDisplayCount(n);
            if (!isEditing) setInputValue(String(n));
        });
        return unsub;
    }, [isEditing]);

    // sync input display when not editing
    useEffect(() => {
        if (!isEditing) setInputValue(String(displayCount));
    }, [displayCount, isEditing]);

    // ── compute default position (bottom-centre) once parent is known ─────────
    useLayoutEffect(() => {
        if (position.x !== -1) return; // already have a saved position
        const parent = sentinelRef.current?.parentElement;
        if (!parent) return;
        const pw = parent.offsetWidth;
        const ph = parent.offsetHeight;
        const x = Math.max(0, Math.round((pw - size.width) / 2));
        const y = Math.max(0, ph - size.height - 50);
        setPosition({ x, y });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── persistence helpers ───────────────────────────────────────────────────
    const savePosition = useCallback((x: number, y: number) => {
        const next = { x, y };
        setPosition(next);
        try { localStorage.setItem(posKeyFor(isMobile), JSON.stringify(next)); } catch { /* ignore */ }
    }, [isMobile]);

    const saveSize = useCallback((w: number, h: number) => {
        const next = { width: w, height: h };
        setSize(next);
        setScale(computeScale(w, h));
        try { localStorage.setItem(sizeKeyFor(isMobile), JSON.stringify(next)); } catch { /* ignore */ }
    }, [isMobile]);

    // ── reset to default position/size (bottom-centre, default dims) ─────────
    // Bumping this key forces react-rnd to remount with fresh `default` values,
    // since position/size are now uncontrolled (see FloatingDCirclesWidget notes).
    const [resetKey, setResetKey] = useState(0);

    const handleReset = useCallback(() => {
        const parent = sentinelRef.current?.parentElement;
        const defaultSize = isMobile
            ? { width: DEFAULT_W_MOBILE, height: DEFAULT_H_MOBILE }
            : { width: DEFAULT_W, height: DEFAULT_H };

        let defaultPos = { x: 20, y: 20 };
        if (parent) {
            const pw = parent.offsetWidth;
            const ph = parent.offsetHeight;
            defaultPos = {
                x: Math.max(0, Math.round((pw - defaultSize.width) / 2)),
                y: Math.max(0, ph - defaultSize.height - 50),
            };
        }

        setSize(defaultSize);
        setScale(computeScale(defaultSize.width, defaultSize.height));
        setPosition(defaultPos);
        try {
            localStorage.setItem(sizeKeyFor(isMobile), JSON.stringify(defaultSize));
            localStorage.setItem(posKeyFor(isMobile), JSON.stringify(defaultPos));
        } catch { /* ignore */ }
        setResetKey(k => k + 1);
    }, [isMobile]);

    // ── live scale update during resize (no extra observers/renders elsewhere) ─
    const handleResize = useCallback((_e: unknown, _dir: unknown, ref: HTMLElement) => {
        setScale(computeScale(parseInt(ref.style.width, 10), parseInt(ref.style.height, 10)));
    }, []);

    // ── SmartCharts pointer-event toggle during drag ──────────────────────────
    const disableChart = useCallback(() => {
        const el = document.querySelector('.dashboard__chart-wrapper') as HTMLElement | null;
        if (el) el.style.pointerEvents = 'none';
    }, []);

    const enableChart = useCallback(() => {
        const el = document.querySelector('.dashboard__chart-wrapper') as HTMLElement | null;
        if (el) el.style.pointerEvents = '';
    }, []);

    // Ensure chart pointer-events are restored if component unmounts while dragging
    useEffect(() => () => enableChart(), [enableChart]);

    // ── wait until position is initialised ───────────────────────────────────
    if (position.x === -1) {
        return (
            <div
                ref={sentinelRef}
                style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
            />
        );
    }

    return (
        /* Sentinel fills the parent — Rnd uses it as the bounds container */
        <div
            ref={sentinelRef}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        >
            <Rnd
                key={resetKey}
                default={{
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                }}
                minWidth={MIN_W}
                minHeight={MIN_H}
                bounds='parent'
                cancel='input, button, .dc-no-drag'
                style={{ pointerEvents: 'all', zIndex: 100, touchAction: 'none' }}
                onDragStart={disableChart}
                onDragStop={(_e, d) => {
                    enableChart();
                    savePosition(d.x, d.y);
                }}
                onResize={handleResize}
                onResizeStop={(_e, _dir, ref, _delta, pos) => {
                    saveSize(
                        parseInt(ref.style.width,  10),
                        parseInt(ref.style.height, 10)
                    );
                    savePosition(pos.x, pos.y);
                }}
                enableResizing={{
                    top:         true,
                    right:       true,
                    bottom:      true,
                    left:        true,
                    topRight:    true,
                    bottomRight: true,
                    bottomLeft:  true,
                    topLeft:     true,
                }}
            >
                {/* ── Widget shell — the "window"; content below is scaled to fill it ── */}
                <div
                    style={{
                        width: '100%',
                        height: '100%',
                        background: 'rgba(10,12,18,0.82)',
                        borderRadius: 12,
                        border: '1px solid rgba(255,255,255,0.10)',
                        backdropFilter: 'blur(8px)',
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                        boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
                        cursor: 'grab',
                    }}
                >
                    {/* ── Header (purely visual — the whole panel is draggable) ── */}
                    <div
                        style={{
                            padding: '5px 10px',
                            background: 'rgba(255,255,255,0.05)',
                            borderBottom: '1px solid rgba(255,255,255,0.07)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            userSelect: 'none',
                            flexShrink: 0,
                        }}
                    >
                        <span
                            style={{
                                color: '#99aabb',
                                fontSize: 12,
                                fontFamily: 'monospace',
                                letterSpacing: 1,
                            }}
                        >
                            ⠿ DCircles
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: '#445', fontSize: 10 }}>
                                drag anywhere · resize any edge
                            </span>
                            <button
                                type='button'
                                className='dc-no-drag'
                                onClick={handleReset}
                                title='Reset position and size'
                                style={{
                                    background: 'rgba(255,255,255,0.08)',
                                    border: '1px solid rgba(255,255,255,0.15)',
                                    borderRadius: 6,
                                    color: '#99aabb',
                                    fontSize: 10,
                                    padding: '3px 7px',
                                    cursor: 'pointer',
                                    lineHeight: 1,
                                    flexShrink: 0,
                                }}
                            >
                                ⟲ Reset
                            </button>
                        </div>
                    </div>

                    {/* ── Scaled content viewport — never crops, never reflows ──
                        The inner canvas is a fixed DESIGN_W x DESIGN_H box.
                        Resizing the window only changes `scale`, applied via a
                        single GPU-accelerated transform so every child (circles,
                        labels, spacing, fonts, controls) grows/shrinks together
                        while the layout itself stays pixel-identical. */}
                    <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
                        <div
                            style={{
                                width: DESIGN_W,
                                height: DESIGN_H,
                                transform: `scale(${scale})`,
                                transformOrigin: 'top left',
                                willChange: 'transform',
                            }}
                        >
                            <div style={{ padding: '6px 10px' }}>
                                <DigitCircles digits={visibleDigits} />
                            </div>

                            {/* Digits-to-show control — shown on mobile and desktop */}
                            <div
                                className='dc-no-drag'
                                style={{
                                    textAlign: 'center',
                                    padding: '4px 10px 8px',
                                    borderTop: '1px solid rgba(255,255,255,0.05)',
                                    flexShrink: 0,
                                }}
                            >
                                <div
                                    style={{
                                        color: '#ccc',
                                        fontSize: 11,
                                        marginBottom: 4,
                                    }}
                                >
                                    Last Ticks
                                </div>
                                <input
                                    type='number'
                                    value={inputValue}
                                    onFocus={() => setIsEditing(true)}
                                    onChange={e => {
                                        const val = e.target.value;
                                        if (val === '') { setInputValue(''); return; }
                                        if (!/^\d+$/.test(val)) return;
                                        setInputValue(val);
                                        const clamped = Math.min(DISPLAY_COUNT_MAX, Math.max(100, Number(val)));
                                        setDisplayCount(clamped);
                                        globalTickEngine.setLimit(clamped);
                                    }}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') {
                                            let val = Number(inputValue);
                                            if (isNaN(val)) val = 1000;
                                            val = Math.min(DISPLAY_COUNT_MAX, Math.max(100, val));
                                            setDisplayCount(val);
                                            setInputValue(String(val));
                                            setIsEditing(false);
                                            globalTickEngine.setLimit(val);
                                            (e.target as HTMLInputElement).blur();
                                        }
                                    }}
                                    onBlur={() => {
                                        let val = Number(inputValue);
                                        if (isNaN(val)) val = 1000;
                                        val = Math.min(DISPLAY_COUNT_MAX, Math.max(100, val));
                                        setDisplayCount(val);
                                        setInputValue(String(val));
                                        setIsEditing(false);
                                        globalTickEngine.setLimit(val);
                                    }}
                                    style={{
                                        padding: '6px 10px',
                                        borderRadius: 10,
                                        border: '1px solid #00ffcc',
                                        background: '#111',
                                        color: '#00ffcc',
                                        fontWeight: 600,
                                        width: 90,
                                        textAlign: 'center',
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                </div>
            </Rnd>
        </div>
    );
});

FloatingDCirclesWidget.displayName = 'FloatingDCirclesWidget';
export default FloatingDCirclesWidget;
