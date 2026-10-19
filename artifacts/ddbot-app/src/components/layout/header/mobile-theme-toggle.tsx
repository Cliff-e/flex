import { observer } from 'mobx-react-lite';
import useThemeSwitcher from '@/hooks/useThemeSwitcher';
import { LegacyThemeDarkIcon, LegacyThemeLightIcon } from '@deriv/quill-icons/Legacy';
import { useTranslations } from '@deriv-com/translations';
import './mobile-theme-toggle.scss';

/**
 * Mobile-only theme toggle. Reuses the existing 3-theme cycle from
 * useThemeSwitcher (dark → light → CKK Green) so every theme is preserved.
 * aria-label/title carry a clear text label for touch and screen readers.
 */
const MobileThemeToggle = observer(() => {
    const { theme, theme_label, toggleTheme, is_dark_mode_on } = useThemeSwitcher();
    const { localize } = useTranslations();
    const label = `${localize('Change theme')} — ${theme_label}`;

    return (
        <button
            type='button'
            className={`mobile-theme-toggle mobile-theme-toggle--${theme}`}
            aria-label={label}
            title={label}
            onClick={toggleTheme}
            data-testid='mobile-theme-toggle'
        >
            <span className='mobile-theme-toggle__swatch' aria-hidden='true' />
            {is_dark_mode_on ? (
                <LegacyThemeDarkIcon iconSize='xs' />
            ) : (
                <LegacyThemeLightIcon iconSize='xs' />
            )}
        </button>
    );
});

export default MobileThemeToggle;
