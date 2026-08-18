import { useEffect, useState } from 'react';
import { CONNECTION_STATUS } from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { useApiBase } from '@/hooks/useApiBase';
import { EventBus } from '@/utils/EventBus';
import { ChartDataLayer } from '@/utils/ChartDataLayer';

type DataMode = 'preview' | 'live';

const ChartConnectionBadge = () => {
    const { connectionStatus } = useApiBase();
    const [mode, setMode] = useState<DataMode>(() => ChartDataLayer.mode);
    const [pulse, setPulse] = useState(false);

    // Track chart data mode (preview ↔ live)
    useEffect(() => {
        const unsub = EventBus.on('chart:mode_changed', ({ mode: m }) => setMode(m));
        return unsub;
    }, []);

    // Pulsing dot animation when live
    useEffect(() => {
        if (mode !== 'live') { setPulse(false); return; }
        const t = setInterval(() => setPulse(p => !p), 1200);
        return () => clearInterval(t);
    }, [mode]);

    // Derive WS status from connectionStatus for the dot color
    const wsConnected = connectionStatus === CONNECTION_STATUS.OPENED;

    const isLive    = mode === 'live';
    const dotColor  = isLive   ? '#00c853' : '#ffa000';
    const bgColor   = isLive   ? 'rgba(0,40,20,0.70)' : 'rgba(40,30,0,0.70)';
    const label     = isLive   ? 'LIVE' : 'PREVIEW';
    const sublabel  = isLive   ? 'Real market data' : 'Simulated data';
    const glowSize  = isLive && pulse ? '0 0 8px 2px rgba(0,200,80,0.7)' : 'none';

    return (
        <div
            title={sublabel}
            style={{
                position: 'absolute',
                top: 8,
                right: 8,
                zIndex: 30,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: bgColor,
                border: `1px solid ${dotColor}33`,
                borderRadius: 20,
                padding: '4px 10px 4px 8px',
                backdropFilter: 'blur(6px)',
                boxShadow: '0 1px 6px rgba(0,0,0,0.4)',
                transition: 'background 0.4s, border-color 0.4s',
                pointerEvents: 'none',
                userSelect: 'none',
            }}
        >
            {/* Status dot */}
            <span
                style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: dotColor,
                    display: 'inline-block',
                    boxShadow: glowSize,
                    transition: 'box-shadow 0.6s ease, background 0.4s',
                    flexShrink: 0,
                }}
            />

            {/* Labels */}
            <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                <span
                    style={{
                        color: dotColor,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        whiteSpace: 'nowrap',
                        transition: 'color 0.4s',
                    }}
                >
                    {label}
                </span>
                <span
                    style={{
                        color: 'rgba(255,255,255,0.55)',
                        fontSize: 9,
                        fontWeight: 400,
                        letterSpacing: '0.03em',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {sublabel}
                </span>
            </span>
        </div>
    );
};

export default ChartConnectionBadge;
