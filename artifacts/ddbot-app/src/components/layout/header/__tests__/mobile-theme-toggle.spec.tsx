import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileThemeToggle from '../mobile-theme-toggle';

jest.mock('@/hooks/useThemeSwitcher', () => ({
    __esModule: true,
    default: jest.fn(),
}));

jest.mock('@deriv/quill-icons/Legacy', () => ({
    LegacyThemeDarkIcon: () => <svg data-testid='dark-icon' />,
    LegacyThemeLightIcon: () => <svg data-testid='light-icon' />,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const useThemeSwitcher = require('@/hooks/useThemeSwitcher').default as jest.Mock;

describe('MobileThemeToggle', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('renders an accessible button with the current theme label', () => {
        useThemeSwitcher.mockReturnValue({
            theme: 'dark',
            theme_label: 'Dark',
            toggleTheme: jest.fn(),
            is_dark_mode_on: true,
        });

        render(<MobileThemeToggle />);

        const button = screen.getByRole('button');
        expect(button).toHaveAttribute('aria-label', 'Change theme — Dark');
        expect(button).toHaveAttribute('data-testid', 'mobile-theme-toggle');
    });

    it('cycles the theme when clicked', async () => {
        const toggleTheme = jest.fn();
        useThemeSwitcher.mockReturnValue({
            theme: 'dark',
            theme_label: 'Dark',
            toggleTheme,
            is_dark_mode_on: true,
        });

        render(<MobileThemeToggle />);
        await userEvent.click(screen.getByRole('button'));

        expect(toggleTheme).toHaveBeenCalledTimes(1);
    });

    it('preserves the CKK Green theme in its label', () => {
        useThemeSwitcher.mockReturnValue({
            theme: 'ckk-green',
            theme_label: 'CKK Green',
            toggleTheme: jest.fn(),
            is_dark_mode_on: true,
        });

        render(<MobileThemeToggle />);

        expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Change theme — CKK Green');
    });
});
