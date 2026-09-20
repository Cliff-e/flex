/**
 * Headless stub for @deriv-com/translations.
 *
 * The real package initialises i18next against a browser locale and a CDN, which
 * has no meaning inside a headless trading process - left uninitialised, its
 * `localize()` returns undefined, which makes Blockly reject block definitions
 * ('args0 must have a corresponding message (message0)') and stops code
 * generation for every strategy.
 *
 * This mirrors the identity behaviour the workspace already relies on for jest
 * (see __mocks__/translation.mock.js) and implements the package's full public
 * surface, so any module on the runtime path can import from it unchanged.
 *
 * Block labels are never rendered headlessly, and generated code only embeds
 * localised text inside human-readable log strings - never in trading logic.
 */
import { createElement, Fragment } from 'react';

type LocalizeValues = Record<string, string | number>;

/** Interpolates {{placeholders}} with the supplied values; never returns undefined. */
export const localize = (text: string, values?: LocalizeValues): string => {
    if (!values) return text;
    return text.replace(/{{(.*?)}}/g, (placeholder: string, key: string) => {
        const value = values[key.trim()];
        return value === undefined ? placeholder : String(value);
    });
};

export const getInitialLanguage = (): string => 'EN';

export const getAllowedLanguages = (): Record<string, string> => ({ EN: 'English' });

export const initializeI18n = (_config?: Record<string, unknown>): undefined => undefined;

export const loadIncontextTranslation = (): Promise<void> => Promise.resolve();

export const useTranslations = (): { localize: typeof localize; currentLang: string } => ({
    localize,
    currentLang: 'EN',
});

type LocalizeProps = { i18n_default_text: string; values?: LocalizeValues };

export const Localize = ({ i18n_default_text, values }: LocalizeProps) =>
    createElement('span', null, localize(i18n_default_text, values));

export const TranslationProvider = ({ children }: { children?: unknown }) =>
    createElement(Fragment, null, children as never);
