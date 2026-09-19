/**
 * Theme helpers — single source of truth for the app theme cycle.
 *
 * The app ships three themes:
 *   dark      → the existing navy / electric-cyan layer (futuristic-theme.scss)
 *   light     → the existing shipped light palette (_themes.scss)
 *   ckk-green → the dark-green futuristic layer (ckk-green-theme.scss)
 *
 * CKK Green intentionally ALSO carries the `theme--dark` class: it is a dark
 * theme, so every existing dark rule (component overrides, the --du-* token
 * namespace, Blockly's dark rendering, smartcharts) keeps applying and the
 * green layer only re-tints the palette tokens.
 */
export type TTheme = 'dark' | 'light' | 'ckk-green';

export const THEMES: TTheme[] = ['dark', 'light', 'ckk-green'];

export const THEME_LABELS: Record<TTheme, string> = {
    dark: 'Dark',
    light: 'Light',
    'ckk-green': 'CKK Green',
};

export const DEFAULT_THEME: TTheme = 'dark';

export const THEME_STORAGE_KEY = 'theme';

/** Body classes applied per theme (order matters: dark first, accent last). */
const THEME_BODY_CLASSES: Record<TTheme, string[]> = {
    dark: ['theme--dark'],
    light: ['theme--light'],
    'ckk-green': ['theme--dark', 'theme--ckk-green'],
};

/** Every class owned by the theme system, removed before applying a new one. */
const ALL_THEME_BODY_CLASSES = ['theme--dark', 'theme--light', 'theme--ckk-green'];

export const isTheme = (value: unknown): value is TTheme => THEMES.includes(value as TTheme);

/** Unknown / missing stored values fall back to the shipped default (dark). */
export const normaliseTheme = (value: string | null | undefined): TTheme =>
    isTheme(value) ? value : DEFAULT_THEME;

/** Next theme in the cycle: dark → light → CKK Green → dark. */
export const nextTheme = (theme: TTheme): TTheme => {
    const current = normaliseTheme(theme);
    return THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
};

/**
 * Applies a theme to the document body and persists it.
 * Returns the normalised theme that was actually applied.
 */
export const applyTheme = (theme: TTheme): TTheme => {
    const next = normaliseTheme(theme);

    const body = document.querySelector('body');
    if (body) {
        body.classList.remove(...ALL_THEME_BODY_CLASSES);
        body.classList.add(...THEME_BODY_CLASSES[next]);
    }

    try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
        /* storage can be unavailable (private mode / blocked cookies) — theme still applies */
    }

    return next;
};

/** Theme persisted by the user, normalised. */
export const readStoredTheme = (): TTheme => {
    try {
        return normaliseTheme(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
        return DEFAULT_THEME;
    }
};
