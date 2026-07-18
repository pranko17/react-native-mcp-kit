import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { resources } from './resources';

// A standard i18next instance — structurally satisfies the library's `I18nLike`
// contract, so it can be passed straight to `<McpProvider i18n={i18n} />`.
void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  ns: ['translation'],
  defaultNS: 'translation',
  // Hermes ships Intl on RN 0.81, but `compatibilityJSON: 'v4'` keeps plural
  // handling deterministic across engines. We avoid i18next plurals anyway and
  // interpolate counts directly, so this is just belt-and-braces.
  compatibilityJSON: 'v4',
  interpolation: { escapeValue: false },
});

export default i18n;
