import { nextTheme, applyTheme, readStoredTheme, THEMES, THEME_STORAGE_KEY } from '../theme';

describe('theme helpers', () => {
    beforeEach(() => {
        document.body.className = '';
        localStorage.clear();
    });

    it('cycles through all three themes in order', () => {
        expect(nextTheme('dark')).toBe('light');
        expect(nextTheme('light')).toBe('ckk-green');
        expect(nextTheme('ckk-green')).toBe('dark');
    });

    it('applies body classes and persists the theme', () => {
        const applied = applyTheme('ckk-green');
        expect(applied).toBe('ckk-green');
        expect(document.body.classList.contains('theme--dark')).toBe(true);
        expect(document.body.classList.contains('theme--ckk-green')).toBe(true);
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('ckk-green');
    });

    it('normalises unknown stored values to the default dark theme', () => {
        localStorage.setItem(THEME_STORAGE_KEY, 'nonsense');
        expect(readStoredTheme()).toBe('dark');
    });

    it('preserves every supported theme option', () => {
        expect(THEMES).toEqual(['dark', 'light', 'ckk-green']);
    });
});
