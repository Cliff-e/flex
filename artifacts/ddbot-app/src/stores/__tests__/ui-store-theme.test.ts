jest.mock('@/components/shared/utils/screen/responsive', () => ({
    isTouchDevice: () => false,
}));

import UiStore from '../ui-store';
import { THEME_STORAGE_KEY } from '@/utils/theme';

describe('UiStore theme state', () => {
    beforeEach(() => {
        document.body.className = '';
        localStorage.clear();
    });

    it('applies and persists the selected theme across the 3-theme cycle', () => {
        const store = new UiStore();

        store.setTheme('light');
        expect(store.theme).toBe('light');
        expect(store.is_dark_mode_on).toBe(false);
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
        expect(document.body.classList.contains('theme--light')).toBe(true);

        store.setTheme('ckk-green');
        expect(store.theme).toBe('ckk-green');
        // CKK Green is a dark theme
        expect(store.is_dark_mode_on).toBe(true);
        expect(document.body.classList.contains('theme--ckk-green')).toBe(true);
        expect(document.body.classList.contains('theme--dark')).toBe(true);
    });

    it('initialises from the stored theme', () => {
        localStorage.setItem(THEME_STORAGE_KEY, 'ckk-green');
        const store = new UiStore();
        expect(store.theme).toBe('ckk-green');
    });
});
