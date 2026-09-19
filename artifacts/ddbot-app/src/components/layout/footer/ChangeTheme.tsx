import { observer } from 'mobx-react-lite';
import useThemeSwitcher from '@/hooks/useThemeSwitcher';
import { LegacyThemeDarkIcon, LegacyThemeLightIcon } from '@deriv/quill-icons/Legacy';
import { useTranslations } from '@deriv-com/translations';
import { Tooltip } from '@deriv-com/ui';

const ChangeTheme = observer(() => {
    const { theme, theme_label, toggleTheme, is_dark_mode_on } = useThemeSwitcher();
    const { localize } = useTranslations();

    return (
        <Tooltip
            as='button'
            type='button'
            className={`app-footer__theme-button app-footer__theme-button--${theme}`}
            tooltipContent={`${localize('Change theme')} — ${theme_label}`}
            onClick={toggleTheme}
        >
            <span className='app-footer__theme-button-swatch' aria-hidden='true' />
            {is_dark_mode_on ? (
                <LegacyThemeDarkIcon iconSize='xs' className='app-footer__theme-button-icon' />
            ) : (
                <LegacyThemeLightIcon iconSize='xs' className='app-footer__theme-button-icon' />
            )}
            <span className='app-footer__theme-button-label'>{theme_label}</span>
        </Tooltip>
    );
});

export default ChangeTheme;

