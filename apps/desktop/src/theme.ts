import {
  createTheme,
  darken,
  isLightColor,
  lighten,
  luminance,
  toRgba,
  type CSSVariablesResolver,
  type MantineColorsTuple,
} from '@mantine/core';
import { SelenizedDark, SelenizedLight, type SelenizedAccent } from './selenized';

/** WCAG 2 AA for normal text. The E2E's axe checks hold every view to it, in both color schemes. */
export const AA_CONTRAST = 4.5;
/** The relative luminance at which black and white text have equal contrast (WCAG 2). */
const EQUAL_CONTRAST_LUMINANCE = 0.179;
const ADJUST_STEP = 0.05;
const FILLED_HOVER_ADJUST = 0.1;
const BLACK = '#000';
const WHITE = '#fff';
/** Every filled color is shade 7, the Selenized light accent, in both schemes. */
const FILLED_SHADE = 7;
/** Mantine hovers a filled color on the next shade. */
const FILLED_HOVER_SHADE = 8;
/** The Selenized dark accent sits at shade 5 and its bright value at shade 4. */
const DARK_BASE_SHADE = 5;
const DARK_BRIGHT_SHADE = 4;
/** How much of the accent a light-variant background mixes into the dark body, at rest and hovered. */
const DARK_LIGHT_TINT = 0.2;
const DARK_LIGHT_HOVER_TINT = 0.3;

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `text`, moved in small steps away from `background` (darker on a light one) until it reads at AA. */
export function readableOn(text: string, background: string): string {
  const adjust = isLightColor(background, EQUAL_CONTRAST_LUMINANCE) ? darken : lighten;
  let color = text;
  for (
    let amount = ADJUST_STEP;
    contrastRatio(color, background) < AA_CONTRAST && amount <= 1;
    amount += ADJUST_STEP
  ) {
    color = adjust(text, amount);
  }
  return color;
}

/** `from` mixed toward `to` by `weight` (0 to 1), as a hex color. */
function mix(from: string, to: string, weight: number): string {
  const a = toRgba(from);
  const b = toRgba(to);
  const channel = (x: number, y: number) =>
    Math.round(x + (y - x) * weight)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(a.r, b.r)}${channel(a.g, b.g)}${channel(a.b, b.b)}`;
}

/**
 * One Mantine scale for a Selenized accent, light to dark: tints of the light accent over the light body,
 * the dark variant's bright and base values (4, 5), then the light variant's base and bright (7, 8).
 */
function accentScale(accent: SelenizedAccent): MantineColorsTuple {
  const dark = SelenizedDark.accents[accent];
  const light = SelenizedLight.accents[accent];
  return [
    mix(SelenizedLight.bg0, light.base, 0.1),
    mix(SelenizedLight.bg0, light.base, 0.2),
    mix(SelenizedLight.bg0, light.base, 0.3),
    mix(SelenizedLight.bg0, dark.bright, 0.65),
    dark.bright,
    dark.base,
    mix(dark.base, light.base, 0.5),
    light.base,
    light.bright,
    mix(light.bright, SelenizedLight.fg1, 0.35),
  ];
}

/**
 * Mantine's `dark` scale paints the dark scheme: text at 0, the body at 7. Shade 5, a hovered control or
 * table row, sits a third of the way from bg_1 to bg_2: any nearer bg_2 and dimmed fg_0 misses AA on it.
 */
const dark: MantineColorsTuple = [
  SelenizedDark.fg1,
  SelenizedDark.fg0,
  mix(SelenizedDark.fg0, SelenizedDark.dim0, 0.5),
  SelenizedDark.dim0,
  SelenizedDark.bg2,
  mix(SelenizedDark.bg1, SelenizedDark.bg2, 0.35),
  SelenizedDark.bg1,
  SelenizedDark.bg0,
  mix(SelenizedDark.bg0, BLACK, 0.25),
  mix(SelenizedDark.bg0, BLACK, 0.5),
];

/** Mantine's `gray` scale paints the light scheme: the body at 0, text at 8. */
const gray: MantineColorsTuple = [
  SelenizedLight.bg0,
  SelenizedLight.bg1,
  mix(SelenizedLight.bg1, SelenizedLight.bg2, 0.5),
  SelenizedLight.bg2,
  mix(SelenizedLight.bg2, SelenizedLight.dim0, 0.4),
  SelenizedLight.dim0,
  mix(SelenizedLight.dim0, SelenizedLight.fg0, 0.5),
  SelenizedLight.fg0,
  SelenizedLight.fg1,
  mix(SelenizedLight.fg1, BLACK, 0.35),
];

/** Every Mantine hue maps to a Selenized accent, so no stock Mantine color reaches the screen. */
const ACCENT_OF_HUE = {
  red: 'red',
  pink: 'magenta',
  grape: 'magenta',
  violet: 'violet',
  indigo: 'violet',
  blue: 'blue',
  cyan: 'cyan',
  teal: 'cyan',
  green: 'green',
  lime: 'green',
  yellow: 'yellow',
  orange: 'orange',
} as const satisfies Record<string, SelenizedAccent>;

export const theme = createTheme({
  colors: {
    dark,
    gray,
    ...Object.fromEntries(
      Object.entries(ACCENT_OF_HUE).map(([hue, accent]) => [hue, accentScale(accent)]),
    ),
  },
  primaryColor: 'blue',
  primaryShade: FILLED_SHADE,
  // Filled components pick black or white text by luminance. At the equal-contrast threshold the pick is
  // always the better of the two, which is at least 4.58:1 on any color.
  autoContrast: true,
  luminanceThreshold: EQUAL_CONTRAST_LUMINANCE,
  defaultRadius: 'md',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, monospace',
});

/**
 * The hover background of a filled color. Mantine hovers on the next shade, which is darker; where that
 * drops the fill's text below AA, the hover is the fill moved away from the text color instead.
 */
function filledHover(shades: MantineColorsTuple): string {
  const fill = shades[FILLED_SHADE];
  const text = isLightColor(fill, EQUAL_CONTRAST_LUMINANCE) ? BLACK : WHITE;
  const hover = shades[FILLED_HOVER_SHADE];
  if (contrastRatio(text, hover) >= AA_CONTRAST) return hover;
  return text === WHITE ? darken(fill, FILLED_HOVER_ADJUST) : lighten(fill, FILLED_HOVER_ADJUST);
}

/**
 * Selenized surfaces for Mantine's scheme variables, and AA where Mantine's defaults miss it.
 * Light-variant and status text are moved away from their background until they read at AA. In the dark
 * scheme a light-variant background is the Selenized dark accent mixed into the body, where Mantine
 * would darken shade 9 into a near-black, and gray's light variant uses the dark surfaces.
 */
export const cssVariablesResolver: CSSVariablesResolver = (t) => {
  const filledHovers = Object.fromEntries(
    Object.entries(t.colors).map(([name, shades]) => [
      `--mantine-color-${name}-filled-hover`,
      filledHover(shades),
    ]),
  );
  const lightBody = t.colors.gray[0];
  const lightHover = t.colors.gray[1];
  const darkBody = t.colors.dark[7];
  const darkHover = t.colors.dark[5];
  const darkAccents = Object.fromEntries(
    Object.entries(t.colors).flatMap(([name, shades]) => {
      if (!(name in ACCENT_OF_HUE)) return [];
      const background = mix(darkBody, shades[DARK_BASE_SHADE], DARK_LIGHT_TINT);
      const hover = mix(darkBody, shades[DARK_BASE_SHADE], DARK_LIGHT_HOVER_TINT);
      return [
        [`--mantine-color-${name}-text`, readableOn(shades[DARK_BRIGHT_SHADE], darkHover)],
        [`--mantine-color-${name}-light`, background],
        [`--mantine-color-${name}-light-hover`, hover],
        [`--mantine-color-${name}-light-color`, readableOn(shades[DARK_BRIGHT_SHADE], hover)],
      ];
    }),
  );
  return {
    variables: {},
    light: {
      '--mantine-color-body': lightBody,
      '--mantine-color-text': t.colors.gray[8],
      '--mantine-color-bright': t.colors.gray[9],
      '--mantine-color-default': lightBody,
      '--mantine-color-default-hover': lightHover,
      '--mantine-color-default-color': t.colors.gray[8],
      '--mantine-color-dimmed': t.colors.gray[7],
      '--mantine-color-error': 'var(--mantine-color-red-text)',
      '--mantine-color-success': 'var(--mantine-color-green-text)',
      ...Object.fromEntries(
        Object.entries(t.colors).flatMap(([name, shades]) => {
          const text = readableOn(shades[FILLED_SHADE], lightHover);
          return [
            [`--mantine-color-${name}-text`, text],
            [`--mantine-color-${name}-light-color`, readableOn(shades[9], shades[2])],
          ];
        }),
      ),
      ...filledHovers,
    },
    dark: {
      '--mantine-color-dimmed': 'var(--mantine-color-dark-1)',
      '--mantine-color-error': 'var(--mantine-color-red-text)',
      '--mantine-color-success': 'var(--mantine-color-green-text)',
      '--mantine-color-gray-text': 'var(--mantine-color-dark-1)',
      '--mantine-color-gray-light': 'var(--mantine-color-dark-6)',
      '--mantine-color-gray-light-hover': 'var(--mantine-color-dark-5)',
      '--mantine-color-gray-light-color': 'var(--mantine-color-dark-0)',
      ...darkAccents,
      ...filledHovers,
    },
  };
};
