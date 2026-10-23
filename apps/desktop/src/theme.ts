import {
  createTheme,
  darken,
  isLightColor,
  luminance,
  type CSSVariablesResolver,
  type MantineColorsTuple,
} from '@mantine/core';

/** WCAG 2 AA for normal text. The E2E's axe checks hold every view to it, in both color schemes. */
export const AA_CONTRAST = 4.5;
/** The relative luminance at which black and white text have equal contrast (WCAG 2). */
const EQUAL_CONTRAST_LUMINANCE = 0.179;
const DARKEN_STEP = 0.05;
const FILLED_HOVER_DARKEN = 0.1;
const BLACK = '#000';
const WHITE = '#fff';

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `text`, darkened in small steps until it reads at AA on `background`. */
export function readableOn(text: string, background: string): string {
  let color = text;
  for (
    let amount = DARKEN_STEP;
    contrastRatio(color, background) < AA_CONTRAST && amount <= 1;
    amount += DARKEN_STEP
  ) {
    color = darken(text, amount);
  }
  return color;
}

/**
 * The hover background of a shade-9 fill. Mantine hovers on shade 8, which is lighter; where that drops
 * the fill's text below AA (white on teal is 3.9:1, on cyan 4.3:1), the hover is the fill darkened
 * instead, which reads at least as well as the fill.
 */
function filledHover(shades: MantineColorsTuple): string {
  const text = isLightColor(shades[9], EQUAL_CONTRAST_LUMINANCE) ? BLACK : WHITE;
  return contrastRatio(text, shades[8]) >= AA_CONTRAST
    ? shades[8]
    : darken(shades[9], FILLED_HOVER_DARKEN);
}

export const theme = createTheme({
  primaryColor: 'teal',
  // White on teal reads at AA only from shade 9 (5.0:1); Mantine's default shades, 6 and 8, give 2.5 and 3.9.
  primaryShade: { light: 9, dark: 9 },
  // Filled components pick black or white text by luminance. At the equal-contrast threshold the pick is
  // always the better of the two, which is at least 4.58:1 on any color.
  autoContrast: true,
  luminanceThreshold: EQUAL_CONTRAST_LUMINANCE,
  defaultRadius: 'md',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, monospace',
});

/**
 * Mantine's defaults miss AA in three places: dimmed text (gray-6 on white is 3.3:1, dark-2 on dark-7 is
 * 4.0:1), light-variant text in the light scheme (shade 9 on shade 1 is 2.7:1 for yellow and 4.3:1
 * for teal, and less on the shade-2 hover background), and a hovered filled teal or cyan. Dimmed text
 * moves one shade toward the text color, light-variant text is darkened until it reads at AA on the hover
 * background, the darker of the two, and a filled hover that misses AA goes darker than the fill.
 */
export const cssVariablesResolver: CSSVariablesResolver = (t) => {
  const filledHovers = Object.fromEntries(
    Object.entries(t.colors).map(([name, shades]) => [
      `--mantine-color-${name}-filled-hover`,
      filledHover(shades),
    ]),
  );
  return {
    variables: {},
    light: {
      '--mantine-color-dimmed': 'var(--mantine-color-gray-7)',
      ...Object.fromEntries(
        Object.entries(t.colors).map(([name, shades]) => [
          `--mantine-color-${name}-light-color`,
          readableOn(shades[9], shades[2]),
        ]),
      ),
      ...filledHovers,
    },
    dark: { '--mantine-color-dimmed': 'var(--mantine-color-dark-1)', ...filledHovers },
  };
};
