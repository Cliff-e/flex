import { useCallback, useState } from 'react';
import { applyTheme, nextTheme, readStoredTheme, THEME_LABELS, THEMES } from '@/utils/theme';
import type { TTheme } from '@/utils/theme';
import { useStore } from './useStore';

/**
 * Owns the 3-state theme cycle: dark → light → CKK Green → dark.
 * Body class + localStorage are handled by applyTheme (utils/theme.ts); the
 * store flag keeps ThemeProvider / smartcharts / dashboard-store in sync.
 */
const useThemeSwitcher = () => {
    const { ui } = useStore() ?? {
        ui: {
            setDarkMode: () => {},
            is_dark_mode_on: false,
        },
    };
    const { setDarkMode, is_dark_mode_on } = ui;
    const [theme, setThemeState] = useState<TTheme>(readStoredTheme);

    const setTheme = useCallback(
        (next: TTheme) => {
            const applied = applyTheme(next);
            setThemeState(applied);
            // Light is the only light theme — Dark and CKK Green are both dark for
            // downstream consumers (@deriv-com/ui ThemeProvider, smartcharts, stores).
            setDarkMode(applied !== 'light');
        },
        [setDarkMode]
    );

    const toggleTheme = useCallback(() => setTheme(nextTheme(theme)), [setTheme, theme]);

    /**
     * Binary dark↔light flip for the mobile-menu "Dark theme" switch.
     * CKK Green is a dark theme, so flipping it lands on Light.
     */
    const toggleDarkMode = useCallback(() => setTheme(theme === 'light' ? 'dark' : 'light'), [setTheme, theme]);

    return {
        theme,
        theme_label: THEME_LABELS[theme],
        themes: THEMES,
        setTheme,
        toggleTheme,
        toggleDarkMode,
        is_dark_mode_on,
        setDarkMode,
    };
};

export default useThemeSwitcher;

