import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  isLightColor,
  mergeMantineTheme,
} from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { SelenizedDark, SelenizedLight, type SelenizedAccent } from './selenized';
import { AA_CONTRAST, contrastRatio, cssVariablesResolver, theme } from './theme';

// The variables Mantine 9 renders with 10db's theme: its defaults, then 10db's resolver on top. The
// E2E's axe run checks the real pages.
const resolved = mergeMantineTheme(DEFAULT_THEME, theme);
const defaults = defaultCssVariablesResolver(resolved);
const overrides = cssVariablesResolver(resolved);
const Scheme = { Light: 'light', Dark: 'dark' } as const;
type Scheme = (typeof Scheme)[keyof typeof Scheme];
const SCHEMES = [Scheme.Light, Scheme.Dark] as const;

function cssVar(scheme: Scheme, name: string): string {
  const table: Record<string, string> = {
    ...defaults.variables,
    ...defaults[scheme],
    ...overrides.variables,
    ...overrides[scheme],
  };
  let value = table[name];
  for (let match = /^var\((--[a-z0-9-]+)\)$/.exec(value ?? ''); match;) {
    value = table[match[1] ?? ''];
    match = /^var\((--[a-z0-9-]+)\)$/.exec(value ?? '');
  }
  if (value === undefined) throw new Error(`${name} is not defined in the ${scheme} scheme`);
  return value;
}

const HUES: readonly (readonly [string, SelenizedAccent])[] = [
  ['red', 'red'],
  ['pink', 'magenta'],
  ['grape', 'magenta'],
  ['violet', 'violet'],
  ['indigo', 'violet'],
  ['blue', 'blue'],
  ['cyan', 'cyan'],
  ['teal', 'cyan'],
  ['green', 'green'],
  ['lime', 'green'],
  ['yellow', 'yellow'],
  ['orange', 'orange'],
];
const COLOR_PROPS = [...HUES.map(([name]) => name), 'gray'];

describe('theme palette (Selenized)', () => {
  it.each([
    ['light body', Scheme.Light, '--mantine-color-body', SelenizedLight.bg0],
    ['light text', Scheme.Light, '--mantine-color-text', SelenizedLight.fg1],
    ['light dimmed text', Scheme.Light, '--mantine-color-dimmed', SelenizedLight.fg0],
    ['light control', Scheme.Light, '--mantine-color-default', SelenizedLight.bg0],
    ['light control hover', Scheme.Light, '--mantine-color-default-hover', SelenizedLight.bg1],
    ['dark body', Scheme.Dark, '--mantine-color-body', SelenizedDark.bg0],
    ['dark text', Scheme.Dark, '--mantine-color-text', SelenizedDark.fg1],
    ['dark dimmed text', Scheme.Dark, '--mantine-color-dimmed', SelenizedDark.fg0],
    ['dark control', Scheme.Dark, '--mantine-color-default', SelenizedDark.bg1],
    ['dark border', Scheme.Dark, '--mantine-color-default-border', SelenizedDark.bg2],
  ])('paints the %s from Selenized', (_case, scheme, name, expected) => {
    expect(cssVar(scheme, name)).toBe(expected);
  });

  it.each(HUES)('fills %s with Selenized %s in both schemes', (name, accent) => {
    for (const scheme of SCHEMES)
      expect(cssVar(scheme, `--mantine-color-${name}-filled`)).toBe(
        SelenizedLight.accents[accent].base,
      );
  });

  it('makes Selenized blue the primary color', () => {
    for (const scheme of SCHEMES)
      expect(cssVar(scheme, '--mantine-primary-color-filled')).toBe(
        SelenizedLight.accents.blue.base,
      );
  });

  it.each([
    ['error', 'red'],
    ['success', 'green'],
  ])('colors %s text like %s status text in both schemes', (role, hue) => {
    for (const scheme of SCHEMES)
      expect(cssVar(scheme, `--mantine-color-${role}`)).toBe(
        cssVar(scheme, `--mantine-color-${hue}-text`),
      );
  });
});

describe('theme contrast (WCAG AA)', () => {
  // Text sits on the body, on controls and on hovered rows, controls and nav links.
  const surfaces = [
    '--mantine-color-body',
    '--mantine-color-default',
    '--mantine-color-default-hover',
  ];

  it.each(SCHEMES)(
    'reads text, dimmed, error and success text at AA on every %s surface',
    (scheme) => {
      for (const text of [
        '--mantine-color-text',
        '--mantine-color-dimmed',
        '--mantine-color-error',
        '--mantine-color-success',
      ])
        for (const surface of surfaces)
          expect(
            contrastRatio(cssVar(scheme, text), cssVar(scheme, surface)),
          ).toBeGreaterThanOrEqual(AA_CONTRAST);
    },
  );

  // `c="red"` (a failure reason in the Factory table, a batch's failure on the strip) is
  // var(--mantine-color-red-text).
  it.each(COLOR_PROPS)('reads %s text at AA on every surface in both schemes', (name) => {
    for (const scheme of SCHEMES)
      for (const surface of surfaces)
        expect(
          contrastRatio(cssVar(scheme, `--mantine-color-${name}-text`), cssVar(scheme, surface)),
        ).toBeGreaterThanOrEqual(AA_CONTRAST);
  });

  it.each(COLOR_PROPS)('reads %s light-variant text at AA in both schemes', (name) => {
    for (const scheme of SCHEMES)
      // The background, then the hover background (a hovered NavLink or light Button).
      for (const background of ['light', 'light-hover'])
        expect(
          contrastRatio(
            cssVar(scheme, `--mantine-color-${name}-light-color`),
            cssVar(scheme, `--mantine-color-${name}-${background}`),
          ),
        ).toBeGreaterThanOrEqual(AA_CONTRAST);
  });

  // A Button keeps its text color on hover, and the pointer rests on a button after a click.
  it.each(COLOR_PROPS)(
    'reads text on filled %s at AA, hovered or not, with the color autoContrast picks',
    (name) => {
      for (const scheme of SCHEMES) {
        const fill = cssVar(scheme, `--mantine-color-${name}-filled`);
        const text = isLightColor(fill, resolved.luminanceThreshold)
          ? resolved.black
          : resolved.white;
        for (const background of ['filled', 'filled-hover'])
          expect(
            contrastRatio(text, cssVar(scheme, `--mantine-color-${name}-${background}`)),
          ).toBeGreaterThanOrEqual(AA_CONTRAST);
      }
    },
  );
});
