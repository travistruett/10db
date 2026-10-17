import { createTheme, darken, luminance, type CSSVariablesResolver } from '@mantine/core';

/** WCAG 2 AA for normal text. The E2E's axe checks hold every view to it, in both color schemes. */
export const AA_CONTRAST = 4.5;
/** The relative luminance at which black and white text have equal contrast (WCAG 2). */
const EQUAL_CONTRAST_LUMINANCE = 0.179;
const DARKEN_STEP = 0.05;

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
 * Mantine's defaults miss AA in two places: dimmed text (gray-6 on white is 3.3:1, dark-2 on dark-7 is
 * 4.0:1), and light-variant text in the light scheme (shade 9 on shade 1 is 2.7:1 for yellow and 4.3:1
 * for teal, and less on the shade-2 hover background). Dimmed text moves one shade toward the text color,
 * and light-variant text is darkened until it reads at AA on the hover background, the darker of the two.
 */
export const cssVariablesResolver: CSSVariablesResolver = (t) => ({
  variables: {},
  light: {
    '--mantine-color-dimmed': 'var(--mantine-color-gray-7)',
    ...Object.fromEntries(
      Object.entries(t.colors).map(([name, shades]) => [
        `--mantine-color-${name}-light-color`,
        readableOn(shades[9], shades[2]),
      ]),
    ),
  },
  dark: { '--mantine-color-dimmed': 'var(--mantine-color-dark-1)' },
});
