import { darken, DEFAULT_THEME, isLightColor, mergeMantineTheme } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { AA_CONTRAST, contrastRatio, cssVariablesResolver, theme } from './theme';

// The pairs Mantine 9 renders, resolved with 10db's theme. The E2E's axe run checks the real pages.
const resolved = mergeMantineTheme(DEFAULT_THEME, theme);
const vars = cssVariablesResolver(resolved);
const palettes = Object.entries(resolved.colors);
const shade = (ref: string): string => {
  const match = /^var\(--mantine-color-([a-z]+)-(\d)\)$/.exec(ref);
  const color = match ? resolved.colors[match[1] ?? '']?.[Number(match[2])] : ref;
  if (color === undefined) throw new Error(`unknown color ${ref}`);
  return color;
};

describe('theme contrast (WCAG AA)', () => {
  it('reads dimmed text at AA on the body in both schemes', () => {
    expect(
      contrastRatio(shade(vars.light['--mantine-color-dimmed'] ?? ''), resolved.white),
    ).toBeGreaterThanOrEqual(AA_CONTRAST);
    expect(
      contrastRatio(shade(vars.dark['--mantine-color-dimmed'] ?? ''), resolved.colors.dark[7]),
    ).toBeGreaterThanOrEqual(AA_CONTRAST);
  });

  it.each(palettes)('reads %s light-variant text at AA in both schemes', (name, shades) => {
    const lightText = vars.light[`--mantine-color-${name}-light-color`] ?? '';
    // The background, then the hover background (a hovered NavLink or light Button).
    expect(contrastRatio(lightText, shades[1])).toBeGreaterThanOrEqual(AA_CONTRAST);
    expect(contrastRatio(lightText, shades[2])).toBeGreaterThanOrEqual(AA_CONTRAST);
    // Mantine's dark scheme: shade 0 on shade 9 darkened by half.
    expect(contrastRatio(shades[0], darken(shades[9], 0.5))).toBeGreaterThanOrEqual(AA_CONTRAST);
  });

  it.each(palettes)(
    'reads text on filled %s at AA, with the color autoContrast picks',
    (_name, shades) => {
      for (const scheme of ['light', 'dark'] as const) {
        const shadeIndex =
          typeof resolved.primaryShade === 'number'
            ? resolved.primaryShade
            : resolved.primaryShade[scheme];
        const fill = shades[shadeIndex];
        const text = isLightColor(fill, resolved.luminanceThreshold)
          ? resolved.black
          : resolved.white;
        expect(contrastRatio(text, fill)).toBeGreaterThanOrEqual(AA_CONTRAST);
      }
    },
  );

  // A Button keeps its text color on hover, and the pointer rests on a button after a click.
  it.each(palettes)('reads text on hovered filled %s at AA in both schemes', (name, shades) => {
    const text = isLightColor(shades[9], resolved.luminanceThreshold)
      ? resolved.black
      : resolved.white;
    for (const scheme of ['light', 'dark'] as const) {
      // Mantine's own hover is shade 8 when the fill is shade 9.
      const hover = shade(
        vars[scheme][`--mantine-color-${name}-filled-hover`] ?? `var(--mantine-color-${name}-8)`,
      );
      expect(contrastRatio(text, hover)).toBeGreaterThanOrEqual(AA_CONTRAST);
    }
  });
});
