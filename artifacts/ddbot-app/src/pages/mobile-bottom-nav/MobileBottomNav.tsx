import React from 'react';
import './mobile-bottom-nav.scss';

type Props = {
    active_tab: number;
    onTabChange: (tab: number) => void;
};

const NAV_ITEMS = [
    { label: 'Dashboard',    icon: '🏠', tab: 0 },
    { label: 'AI Bots',      icon: '🤖', tab: 6 },
    { label: 'D Circles',    icon: '🔵', tab: 7 },
    { label: 'Deep Trader',  icon: '📊', tab: 9 },
    { label: 'AI Scanner',   icon: '🔍', tab: 8 },
];

const MobileBottomNav = ({ active_tab, onTabChange }: Props) => (
    <nav className='mobile-bottom-nav'>
        {NAV_ITEMS.map(({ label, icon, tab }) => (
            <button
                key={tab}
                className={`mobile-bottom-nav__item${active_tab === tab ? ' mobile-bottom-nav__item--active' : ''}`}
                onClick={() => onTabChange(tab)}
            >
                <span className='mobile-bottom-nav__icon'>{icon}</span>
                <span className='mobile-bottom-nav__label'>{label}</span>
            </button>
        ))}
    </nav>
);

export default MobileBottomNav;
