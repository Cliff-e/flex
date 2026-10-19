import { useCallback, useEffect, useState } from 'react';
import { reaction } from 'mobx';
import { applyTheme, nextTheme, readStoredTheme, THEME_LABELS, THEMES } from '@/utils/theme';
import type { TTheme } from '@/utils/theme';
import { useStore } from './useStore';

/**
 * Owns the 3-state theme cycle: dark → light → CKK Green → dark.
 *
 * Theme state lives in the shared UiStore so every consumer (footer button,
 * mobile toggle, mobile menu switch, ThemeProvider) stays in sync. The MobX
 * `reaction` keeps this hook — and therefore any component using it — updated
 * even when the theme is changed from a different control.
 */
const useThemeSwitcher = () => {
    const store = useStore();
    const ui = store?.ui;
    const [theme, setThemeState] = useState<TTheme>(() => ui?.theme ?? readStoredTheme());

    useEffect(() => {
        if (!ui) return;
        const dispose = reaction(
            () => ui.theme,
            value => setThemeState(value),
            { fireImmediately: true }
        );
        return dispose;
    }, [ui]);

    const setTheme = useCallback(
        (next: TTheme) => {
            if (ui) {
                ui.setTheme(next);
            } else {
                setThemeState(applyTheme(next));
            }
        },
        [ui]
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
        is_dark_mode_on: ui ? ui.is_dark_mode_on : theme !== 'light',
        setDarkMode: ui ? ui.setDarkMode.bind(ui) : () => {},
    };
};

export default useThemeSwitcher;

