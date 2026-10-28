import {
  createTheme,
  defaultVariantColorsResolver,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type VariantColorsResolver,
} from '@mantine/core';
import {
  SelenizedDark,
  SelenizedLight,
  type SelenizedAccent,
  type SelenizedVariant,
} from './selenized';

// Every color 10db paints is a Selenized value, unadjusted: Selenized dark in the dark scheme and
// Selenized light in the light one (docs/architecture/decisions/2026-10-28-selenized-exactly.md).

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
type Hue = keyof typeof ACCENT_OF_HUE;

function isHue(name: string): name is Hue {
  return name in ACCENT_OF_HUE;
}

/** An accent's scale, lightest first: the dark variant's bright and base, the light variant's base and bright. */
function accentScale(accent: SelenizedAccent): MantineColorsTuple {
  const dark = SelenizedDark.accents[accent];
  const light = SelenizedLight.accents[accent];
  return [
    dark.bright,
    dark.bright,
    dark.bright,
    dark.bright,
    dark.bright,
    dark.base,
    dark.base,
    light.base,
    light.bright,
    light.bright,
  ];
}

const D = SelenizedDark;
const L = SelenizedLight;

/** Mantine's `dark` scale paints the dark scheme: text at 0 and 1, the body at 7. */
const dark: MantineColorsTuple = [
  D.fg1,
  D.fg0,
  D.dim0,
  D.dim0,
  D.bg2,
  D.bg1,
  D.bg1,
  D.bg0,
  D.bg0,
  D.bg0,
];

/** Mantine's `gray` scale paints the light scheme: the body at 0, text at 7 and 8. */
const gray: MantineColorsTuple = [
  L.bg0,
  L.bg1,
  L.bg1,
  L.bg2,
  L.bg2,
  L.dim0,
  L.dim0,
  L.fg0,
  L.fg1,
  L.fg1,
];

/** Text on a filled color is the scheme's body color, as a terminal draws reverse video. */
const variantColorResolver: VariantColorsResolver = (input) => {
  const colors = defaultVariantColorsResolver(input);
  return input.variant === 'filled' ? { ...colors, color: 'var(--mantine-color-body)' } : colors;
};

export const theme = createTheme({
  colors: {
    dark,
    gray,
    ...Object.fromEntries(
      Object.entries(ACCENT_OF_HUE).map(([hue, accent]) => [hue, accentScale(accent)]),
    ),
  },
  // Where Mantine uses white or black directly, white is the dark scheme's ink and black the light one's.
  white: D.fg1,
  black: L.fg1,
  primaryColor: 'blue',
  // The light variant's base sits at shade 7 and the dark variant's at shade 5.
  primaryShade: { light: 7, dark: 5 },
  variantColorResolver,
  defaultRadius: 'md',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, monospace',
});

/**
 * One color's variables in one variant. A hue is drawn in its accent: filled, outlined and as text in
 * base, hovered in bright. Gray and dark are drawn in dim_0, hovered in fg_0. Light variants sit on bg_1
 * and hover on bg_2.
 */
function colorVariables(name: string, variant: SelenizedVariant): [string, string][] {
  const { base, bright } = isHue(name)
    ? variant.accents[ACCENT_OF_HUE[name]]
    : { base: variant.dim0, bright: variant.fg0 };
  const prefix = `--mantine-color-${name}`;
  return [
    [`${prefix}-filled`, base],
    [`${prefix}-filled-hover`, bright],
    [`${prefix}-text`, base],
    [`${prefix}-light`, variant.bg1],
    [`${prefix}-light-hover`, variant.bg2],
    [`${prefix}-light-color`, base],
    [`${prefix}-outline`, base],
    [`${prefix}-outline-hover`, variant.bg1],
  ];
}

/** Mantine's scheme variables, each one a value from `variant`. */
function schemeVariables(
  names: readonly string[],
  variant: SelenizedVariant,
): Record<string, string> {
  return {
    '--mantine-color-body': variant.bg0,
    '--mantine-color-text': variant.fg0,
    '--mantine-color-bright': variant.fg1,
    '--mantine-color-dimmed': variant.dim0,
    '--mantine-color-placeholder': variant.dim0,
    '--mantine-color-anchor': variant.accents.blue.base,
    '--mantine-color-error': variant.accents.red.base,
    '--mantine-color-success': variant.accents.green.base,
    '--mantine-color-default': variant.bg1,
    '--mantine-color-default-hover': variant.bg2,
    '--mantine-color-default-color': variant.fg0,
    '--mantine-color-default-border': variant.bg2,
    '--mantine-color-disabled': variant.bg1,
    '--mantine-color-disabled-color': variant.dim0,
    '--mantine-color-disabled-border': variant.bg2,
    '--mantine-primary-color-contrast': variant.bg0,
    ...Object.fromEntries(names.flatMap((name) => colorVariables(name, variant))),
  };
}

export const cssVariablesResolver: CSSVariablesResolver = (t) => {
  const names = Object.keys(t.colors);
  return {
    variables: {},
    light: schemeVariables(names, SelenizedLight),
    dark: schemeVariables(names, SelenizedDark),
  };
};
