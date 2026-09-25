/**
 * The app's own text: i18next + react-i18next, the Oxy ecosystem default.
 *
 * Oxy decides WHICH language (`OxyProvider`'s `language` prop calls
 * `setLanguage`); this module only owns the catalogs. Both catalogs are small
 * and bundled, so `init` is synchronous and `useSuspense` is off: nothing in
 * the boot tree can suspend on a translation (see ~/Oxy/docs/frontend-conventions.md).
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@/locales/en.json';
import es from '@/locales/es.json';

/** The locales this app ships a catalog for, in Oxy's locale spelling. */
export const SUPPORTED_LOCALES = ['en-US', 'es-ES'] as const;
export const FALLBACK_LOCALE = 'en-US';

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    // Keyed by base language: `es-ES` (and any other `es-*`) resolves to `es`.
    resources: { en: { translation: en }, es: { translation: es } },
    lng: FALLBACK_LOCALE,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    initAsync: false,
  });
}

/** `OxyProvider` `language.onChange`: Oxy resolved a (supported) locale. */
export async function setLanguage(locale: string): Promise<void> {
  await i18n.changeLanguage(locale);
}
