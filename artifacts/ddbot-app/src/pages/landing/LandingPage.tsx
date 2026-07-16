import React from 'react';
import { AccountModeController } from '@/utils/AccountModeController';
import { standalone_routes } from '@/components/shared';
import './landing-page.scss';

// Public-folder asset — served at /landing-hero.png, no bundler import needed.
const HERO_IMAGE_URL = '/landing-hero.png';

/** sessionStorage key — set when the user chooses "Continue to Preview". */
export const PREVIEW_MODE_KEY = 'ckk_preview_mode_selected';

type Props = {
    onContinueToPreview: () => void;
};

const LandingPage = ({ onContinueToPreview }: Props) => {
    const [isLoggingIn, setIsLoggingIn] = React.useState(false);

    // Lock body scroll while the landing page is visible.
    React.useEffect(() => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, []);

    const handleLogin = async () => {
        setIsLoggingIn(true);
        try {
            // Exact same call used by the Login button in the app header.
            await AccountModeController.enter({ fromLoginButton: true });
        } catch (err) {
            console.error('[LandingPage] login error:', err);
            setIsLoggingIn(false);
        }
        // No need to reset — the PKCE flow redirects the browser.
    };

    const handleSignUp = () => {
        // Exact same call used by the Sign Up button in the app header.
        window.open(standalone_routes.signup);
    };

    const handlePreview = () => {
        sessionStorage.setItem(PREVIEW_MODE_KEY, '1');
        onContinueToPreview();
    };

    return (
        <div className='ckk-landing'>
            {/* Hero — full-bleed trading-robot image */}
            <div className='ckk-landing__hero' style={{ backgroundImage: `url(${HERO_IMAGE_URL})` }} />

            {/* Three action cards */}
            <div className='ckk-landing__cards'>
                {/* ── Login ── */}
                <button
                    className='ckk-landing__card ckk-landing__card--login'
                    onClick={handleLogin}
                    disabled={isLoggingIn}
                    aria-label='Log in to your account'
                >
                    <span className='ckk-landing__icon ckk-landing__icon--blue'>
                        {/* lock */}
                        <svg viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                            <rect x='5' y='11' width='14' height='10' rx='2' stroke='#3fa9f5' strokeWidth='1.8' />
                            <path d='M8 11V7a4 4 0 0 1 8 0v4' stroke='#3fa9f5' strokeWidth='1.8' strokeLinecap='round' />
                            <circle cx='12' cy='16' r='1.5' fill='#3fa9f5' />
                        </svg>
                    </span>
                    <span className='ckk-landing__label ckk-landing__label--blue'>
                        {isLoggingIn ? 'Redirecting…' : 'LOGIN'}
                    </span>
                    <span className='ckk-landing__desc'>
                        Access your account<br />and continue trading
                    </span>
                </button>

                {/* ── Sign Up ── */}
                <button
                    className='ckk-landing__card ckk-landing__card--signup'
                    onClick={handleSignUp}
                    aria-label='Create a new Deriv account'
                >
                    <span className='ckk-landing__icon ckk-landing__icon--red'>
                        {/* person */}
                        <svg viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                            <circle cx='12' cy='8' r='3.5' stroke='#ff4d4d' strokeWidth='1.8' />
                            <path d='M4 20c0-4 3.582-7 8-7s8 3 8 7' stroke='#ff4d4d' strokeWidth='1.8' strokeLinecap='round' />
                        </svg>
                    </span>
                    <span className='ckk-landing__label ckk-landing__label--red'>SIGN UP</span>
                    <span className='ckk-landing__desc'>
                        Create a new account<br />and get started
                    </span>
                </button>

                {/* ── Continue to Preview ── */}
                <button
                    className='ckk-landing__card ckk-landing__card--preview'
                    onClick={handlePreview}
                    aria-label='Explore the platform in preview mode'
                >
                    <span className='ckk-landing__icon ckk-landing__icon--green'>
                        {/* play */}
                        <svg viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                            <polygon points='8,5 19,12 8,19' fill='none' stroke='#00e5b0' strokeWidth='1.8' strokeLinejoin='round' />
                        </svg>
                    </span>
                    <span className='ckk-landing__label ckk-landing__label--green'>CONTINUE TO PREVIEW</span>
                    <span className='ckk-landing__desc'>
                        Explore the platform<br />in preview mode
                    </span>
                </button>
            </div>

            {/* Footer */}
            <div className='ckk-landing__footer'>
                Powered by Advanced AI&nbsp;&bull;&nbsp;Secure&nbsp;&bull;&nbsp;Reliable&nbsp;&bull;&nbsp;24/7 Automated Trading
            </div>
        </div>
    );
};

export default LandingPage;
