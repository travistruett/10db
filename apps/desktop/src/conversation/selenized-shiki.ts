import type { ThemeRegistration } from 'shiki/core';
import { SelenizedDark, SelenizedLight, type SelenizedVariant } from '../selenized';

// No stock Shiki theme is Selenized, so the two are built here from 10db's palette, every color a
// Selenized value. Token groups follow Selenized's own Vim colors: comments dim, constants and
// strings cyan, keywords yellow, types green, functions blue, imports orange, escapes red.

/** A code theme drawn only in `variant`'s colors, on its `bg_0` with its `fg_0` text. */
export function selenizedShikiTheme(
  variant: SelenizedVariant,
  type: 'light' | 'dark',
): ThemeRegistration {
  const a = variant.accents;
  return {
    name: `selenized-${type}`,
    type,
    fg: variant.fg0,
    bg: variant.bg0,
    colors: { 'editor.background': variant.bg0, 'editor.foreground': variant.fg0 },
    settings: [],
    tokenColors: [
      {
        scope: ['comment', 'punctuation.definition.comment'],
        settings: { foreground: variant.dim0, fontStyle: 'italic' },
      },
      {
        scope: ['string', 'constant', 'constant.numeric', 'constant.language', 'support.constant'],
        settings: { foreground: a.cyan.base },
      },
      {
        scope: ['keyword', 'storage', 'keyword.operator.new', 'keyword.control'],
        settings: { foreground: a.yellow.base },
      },
      {
        scope: ['entity.name.type', 'support.type', 'entity.name.class', 'storage.type'],
        settings: { foreground: a.green.base },
      },
      {
        scope: [
          'entity.name.function',
          'support.function',
          'meta.function-call',
          'entity.name.tag',
        ],
        settings: { foreground: a.blue.base },
      },
      {
        scope: ['keyword.control.import', 'keyword.control.export', 'meta.preprocessor'],
        settings: { foreground: a.orange.base },
      },
      {
        scope: ['constant.character.escape', 'string.regexp', 'invalid'],
        settings: { foreground: a.red.base },
      },
      {
        scope: ['entity.other.attribute-name', 'variable.parameter'],
        settings: { foreground: a.violet.base },
      },
      { scope: ['markup.heading', 'markup.bold'], settings: { foreground: variant.fg1 } },
      { scope: ['markup.inserted'], settings: { foreground: a.green.base } },
      { scope: ['markup.deleted'], settings: { foreground: a.red.base } },
      { scope: ['markup.changed'], settings: { foreground: a.yellow.base } },
    ],
  };
}

/** The dark theme, for the dark scheme, then the light one. */
export const SELENIZED_SHIKI_THEMES: readonly [ThemeRegistration, ThemeRegistration] = [
  selenizedShikiTheme(SelenizedDark, 'dark'),
  selenizedShikiTheme(SelenizedLight, 'light'),
];
