import { describe, expect, it } from 'vitest';
import { SelenizedDark, SelenizedLight, type SelenizedVariant } from '../selenized';
import { SELENIZED_SHIKI_THEMES } from './selenized-shiki';

/** Every color a Selenized variant has, in lower case. */
function valuesOf(variant: SelenizedVariant): Set<string> {
  const { accents, ...tones } = variant;
  return new Set(
    [...Object.values(tones), ...Object.values(accents).flatMap((a) => [a.base, a.bright])].map(
      (c) => c.toLowerCase(),
    ),
  );
}

describe('the Selenized Shiki themes', () => {
  it.each([
    ['dark', SELENIZED_SHIKI_THEMES[0], SelenizedDark, 'dark'],
    ['light', SELENIZED_SHIKI_THEMES[1], SelenizedLight, 'light'],
  ] as const)("%s uses only its variant's colors", (_name, theme, variant, type) => {
    const allowed = valuesOf(variant);
    const colors = [
      ...Object.values(theme.colors ?? {}),
      ...(theme.tokenColors ?? []).flatMap((t) => [t.settings.foreground, t.settings.background]),
    ].filter((c) => c !== undefined);
    expect(colors.length).toBeGreaterThan(4);
    expect(colors.filter((c) => !allowed.has(c.toLowerCase()))).toEqual([]);
    expect(theme.type).toBe(type);
    expect(theme.bg).toBe(variant.bg0);
    expect(theme.fg).toBe(variant.fg0);
    const comment = theme.tokenColors?.find((t) => [t.scope].flat().includes('comment'));
    expect(comment?.settings.foreground).toBe(variant.dim0);
  });

  it('holds both, dark then light, each with a name of its own', () => {
    expect(SELENIZED_SHIKI_THEMES.map((t) => [t.name, t.type])).toEqual([
      ['selenized-dark', 'dark'],
      ['selenized-light', 'light'],
    ]);
  });
});
