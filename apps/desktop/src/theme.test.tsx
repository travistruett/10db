import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  MantineProvider,
  mergeMantineTheme,
  NavLink,
} from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  SelenizedDark,
  SelenizedLight,
  type SelenizedAccent,
  type SelenizedVariant,
} from './selenized';
import { cssVariablesResolver, theme } from './theme';

// The variables Mantine 9 renders with 10db's theme: its defaults, then 10db's resolver on top.
const resolved = mergeMantineTheme(DEFAULT_THEME, theme);
const defaults = defaultCssVariablesResolver(resolved);
const overrides = cssVariablesResolver(resolved);
const Scheme = { Light: 'light', Dark: 'dark' } as const;
type Scheme = (typeof Scheme)[keyof typeof Scheme];
const VARIANT: Record<Scheme, SelenizedVariant> = { light: SelenizedLight, dark: SelenizedDark };

function table(scheme: Scheme): Record<string, string> {
  return {
    ...defaults.variables,
    ...defaults[scheme],
    ...overrides.variables,
    ...overrides[scheme],
  };
}

function cssVar(scheme: Scheme, name: string): string {
  const variables = table(scheme);
  let value = variables[name];
  for (let match = /^var\((--[a-z0-9-]+)\)$/.exec(value ?? ''); match;) {
    value = variables[match[1] ?? ''];
    match = /^var\((--[a-z0-9-]+)\)$/.exec(value ?? '');
  }
  if (value === undefined) throw new Error(`${name} is not defined in the ${scheme} scheme`);
  return value;
}

function values(variant: SelenizedVariant): string[] {
  const { accents, ...surfaces } = variant;
  return [
    ...Object.values(surfaces),
    ...Object.values(accents).flatMap(({ base, bright }) => [base, bright]),
  ];
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

describe('theme palette (Selenized, exactly)', () => {
  // A scale's numbered shades are shared by both schemes; everything else belongs to one.
  const isShade = (name: string) =>
    /-\d$/.test(name) || name === '--mantine-color-white' || name === '--mantine-color-black';
  const colorVariables = (scheme: Scheme) =>
    Object.keys(table(scheme)).filter(
      (name) =>
        /^--mantine-(primary-)?color-/.test(name) &&
        name !== '--mantine-color-scheme' &&
        !isShade(name),
    );

  it.each([Scheme.Light, Scheme.Dark])(
    'resolves every %s color variable to a value from its Selenized variant',
    (scheme) => {
      const allowed = values(VARIANT[scheme]);
      const strays = colorVariables(scheme)
        .map((name) => `${name}: ${cssVar(scheme, name)}`)
        .filter((entry) => !allowed.includes(entry.split(': ')[1] ?? ''));
      expect(strays).toEqual([]);
    },
  );

  it('builds every scale from Selenized values', () => {
    const allowed = [...values(SelenizedLight), ...values(SelenizedDark)];
    const strays = Object.entries(defaults.variables)
      .filter(([name]) => name.startsWith('--mantine-color-') && isShade(name))
      .filter(([, value]) => !allowed.includes(value));
    expect(strays).toEqual([]);
  });

  it.each([
    ['light body', Scheme.Light, '--mantine-color-body', SelenizedLight.bg0],
    ['light text', Scheme.Light, '--mantine-color-text', SelenizedLight.fg0],
    ['light bright text', Scheme.Light, '--mantine-color-bright', SelenizedLight.fg1],
    ['light dimmed text', Scheme.Light, '--mantine-color-dimmed', SelenizedLight.dim0],
    ['light control', Scheme.Light, '--mantine-color-default', SelenizedLight.bg1],
    ['light border', Scheme.Light, '--mantine-color-default-border', SelenizedLight.bg2],
    ['dark body', Scheme.Dark, '--mantine-color-body', SelenizedDark.bg0],
    ['dark text', Scheme.Dark, '--mantine-color-text', SelenizedDark.fg0],
    ['dark bright text', Scheme.Dark, '--mantine-color-bright', SelenizedDark.fg1],
    ['dark dimmed text', Scheme.Dark, '--mantine-color-dimmed', SelenizedDark.dim0],
    ['dark control', Scheme.Dark, '--mantine-color-default', SelenizedDark.bg1],
    ['dark border', Scheme.Dark, '--mantine-color-default-border', SelenizedDark.bg2],
  ])('paints the %s with its Selenized value', (_case, scheme, name, expected) => {
    expect(cssVar(scheme, name)).toBe(expected);
  });

  it.each(HUES)('draws %s as Selenized %s in each scheme', (name, accent) => {
    for (const scheme of [Scheme.Light, Scheme.Dark]) {
      const { base, bright, bg1 } = {
        ...VARIANT[scheme].accents[accent],
        bg1: VARIANT[scheme].bg1,
      };
      expect(cssVar(scheme, `--mantine-color-${name}-filled`)).toBe(base);
      expect(cssVar(scheme, `--mantine-color-${name}-filled-hover`)).toBe(bright);
      expect(cssVar(scheme, `--mantine-color-${name}-text`)).toBe(base);
      // A light ThemeIcon, Badge or Alert: the accent itself on bg_1.
      expect(cssVar(scheme, `--mantine-color-${name}-light-color`)).toBe(base);
      expect(cssVar(scheme, `--mantine-color-${name}-light`)).toBe(bg1);
    }
  });

  it('makes Selenized blue the primary color', () => {
    for (const scheme of [Scheme.Light, Scheme.Dark])
      expect(cssVar(scheme, '--mantine-primary-color-filled')).toBe(
        VARIANT[scheme].accents.blue.base,
      );
  });

  it('writes on a filled color in the body color, like reverse video', () => {
    const colors = resolved.variantColorResolver({
      color: 'green',
      variant: 'filled',
      theme: resolved,
    });
    expect(colors.color).toBe('var(--mantine-color-body)');
  });
});

function defaultProp(component: string, prop: string): unknown {
  const props: unknown = theme.components?.[component]?.defaultProps;
  return typeof props === 'object' && props !== null ? Reflect.get(props, prop) : undefined;
}

describe('theme component defaults', () => {
  it('puts the check of Select and MultiSelect on the right', () => {
    expect(defaultProp('Select', 'checkIconPosition')).toBe('right');
    expect(defaultProp('MultiSelect', 'checkIconPosition')).toBe('right');
  });

  it('turns off the Switch thumb indicator', () => {
    expect(defaultProp('Switch', 'withThumbIndicator')).toBe(false);
  });

  it('rounds nav links and weights the active label', () => {
    render(
      <MantineProvider theme={theme}>
        <NavLink active label="A" />
        <NavLink label="B" />
      </MantineProvider>,
    );
    const a = screen.getByText('A');
    const b = screen.getByText('B');
    expect(a.style.fontWeight).toBe('600');
    expect(b.style.fontWeight).not.toBe('600');
    for (const label of [a, b]) {
      const root = label.closest('[data-mantine-component], a, button') ?? label;
      expect(root.getAttribute('style') ?? '').toContain('border-radius: var(--mantine-radius-md)');
    }
  });
});
