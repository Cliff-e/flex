import './app-splash.scss';

export default function AppSplash({ message }: { message?: string }) {
    return (
        <div className='ckk-splash'>
            <div className='ckk-splash__inner'>

                {/* Computer with charts SVG */}
                <svg className='ckk-splash__computer' viewBox='0 0 220 160' fill='none' xmlns='http://www.w3.org/2000/svg'>
                    {/* Monitor body */}
                    <rect x='20' y='10' width='180' height='115' rx='8' fill='#0b1624' stroke='#1a2f4a' strokeWidth='2.5' />
                    {/* Screen bezel inner */}
                    <rect x='30' y='20' width='160' height='95' rx='4' fill='#040d1a' />

                    {/* Chart grid lines */}
                    <line x1='40' y1='55' x2='180' y2='55' stroke='#0f2340' strokeWidth='1' />
                    <line x1='40' y1='70' x2='180' y2='70' stroke='#0f2340' strokeWidth='1' />
                    <line x1='40' y1='85' x2='180' y2='85' stroke='#0f2340' strokeWidth='1' />
                    <line x1='40' y1='100' x2='180' y2='100' stroke='#0f2340' strokeWidth='1' />

                    {/* Line chart */}
                    <polyline
                        points='40,95 60,80 80,85 100,60 120,70 140,45 160,55 180,35'
                        fill='none'
                        stroke='#009a44'
                        strokeWidth='2.5'
                        strokeLinejoin='round'
                        strokeLinecap='round'
                    />
                    {/* Chart area fill */}
                    <polygon
                        points='40,95 60,80 80,85 100,60 120,70 140,45 160,55 180,35 180,108 40,108'
                        fill='url(#chartGrad)'
                        opacity='0.25'
                    />

                    {/* Bar chart (right side mini) */}
                    <rect x='145' y='78' width='7' height='22' rx='2' fill='#3399ff' opacity='0.8'>
                        <animate attributeName='height' values='22;28;22' dur='1.6s' repeatCount='indefinite' />
                        <animate attributeName='y' values='78;72;78' dur='1.6s' repeatCount='indefinite' />
                    </rect>
                    <rect x='155' y='68' width='7' height='32' rx='2' fill='#009a44' opacity='0.8'>
                        <animate attributeName='height' values='32;24;32' dur='1.2s' repeatCount='indefinite' />
                        <animate attributeName='y' values='68;76;68' dur='1.2s' repeatCount='indefinite' />
                    </rect>
                    <rect x='165' y='74' width='7' height='26' rx='2' fill='#3399ff' opacity='0.8'>
                        <animate attributeName='height' values='26;34;26' dur='1.9s' repeatCount='indefinite' />
                        <animate attributeName='y' values='74;66;74' dur='1.9s' repeatCount='indefinite' />
                    </rect>

                    {/* Pulsing dot on chart line */}
                    <circle cx='180' cy='35' r='4' fill='#009a44'>
                        <animate attributeName='opacity' values='1;0.2;1' dur='1s' repeatCount='indefinite' />
                        <animate attributeName='r' values='4;6;4' dur='1s' repeatCount='indefinite' />
                    </circle>

                    {/* Gradient defs */}
                    <defs>
                        <linearGradient id='chartGrad' x1='0' y1='0' x2='0' y2='1'>
                            <stop offset='0%' stopColor='#009a44' />
                            <stop offset='100%' stopColor='#009a44' stopOpacity='0' />
                        </linearGradient>
                    </defs>

                    {/* Monitor stand */}
                    <rect x='95' y='125' width='30' height='12' rx='2' fill='#0b1624' stroke='#1a2f4a' strokeWidth='2' />
                    {/* Base */}
                    <rect x='75' y='137' width='70' height='8' rx='4' fill='#0b1624' stroke='#1a2f4a' strokeWidth='2' />
                </svg>

                {/* Wordmark */}
                <div className='ckk-splash__logo'>
                    <span className='ckk-splash__logo-ckk'>CKK</span>
                    <span className='ckk-splash__logo-edge'>Edge</span>
                </div>

                {/* Loading bar */}
                <div className='ckk-splash__progress'>
                    <div className='ckk-splash__progress-bar' />
                </div>

                <p className='ckk-splash__msg'>{message ?? 'Initializing...'}</p>
            </div>
        </div>
    );
}
