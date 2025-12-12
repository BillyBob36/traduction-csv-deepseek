/**
 * Configuration des langues disponibles pour la traduction
 * Chaque langue a son code ISO et son nom d'affichage
 */

const LANGUAGES = {
  fr: { name: 'Français', nativeName: 'Français' },
  en: { name: 'Anglais', nativeName: 'English' },
  de: { name: 'Allemand', nativeName: 'Deutsch' },
  es: { name: 'Espagnol', nativeName: 'Español' },
  it: { name: 'Italien', nativeName: 'Italiano' },
  pt: { name: 'Portugais', nativeName: 'Português' },
  nl: { name: 'Néerlandais', nativeName: 'Nederlands' },
  pl: { name: 'Polonais', nativeName: 'Polski' },
  sv: { name: 'Suédois', nativeName: 'Svenska' },
  da: { name: 'Danois', nativeName: 'Dansk' },
  zh: { name: 'Chinois simplifié', nativeName: '简体中文' },
  ja: { name: 'Japonais', nativeName: '日本語' },
  ko: { name: 'Coréen', nativeName: '한국어' },
  fi: { name: 'Finnois', nativeName: 'Suomi' }
};

module.exports = LANGUAGES;
