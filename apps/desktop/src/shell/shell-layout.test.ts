import { describe, expect, it } from 'vitest';
import { ShellBand, shellBand, shellLayout, type ShellLayout } from './shell-layout';

describe('shellBand', () => {
  it.each([
    { width: 1920, band: ShellBand.Wide },
    { width: 1000, band: ShellBand.Wide },
    { width: 999, band: ShellBand.Medium },
    { width: 640, band: ShellBand.Medium },
    { width: 639, band: ShellBand.Narrow },
    { width: 420, band: ShellBand.Narrow },
  ])('$width px is $band', ({ width, band }) => {
    expect(shellBand(width)).toBe(band);
  });
});

describe('shellLayout', () => {
  const rows: readonly {
    readonly name: string;
    readonly input: Parameters<typeof shellLayout>[0];
    readonly expected: ShellLayout;
  }[] = [
    {
      name: 'wide with a panel shows both columns',
      input: { band: ShellBand.Wide, hasPanel: true, panelHidden: false, overlayOpen: false },
      expected: { rail: 'shown', panel: 'column' },
    },
    {
      name: 'wide with a panel the builder hid keeps the rail only',
      input: { band: ShellBand.Wide, hasPanel: true, panelHidden: true, overlayOpen: false },
      expected: { rail: 'shown', panel: 'hidden' },
    },
    {
      name: 'wide ignores a stale overlay request',
      input: { band: ShellBand.Wide, hasPanel: true, panelHidden: false, overlayOpen: true },
      expected: { rail: 'shown', panel: 'column' },
    },
    {
      name: 'medium folds the panel',
      input: { band: ShellBand.Medium, hasPanel: true, panelHidden: false, overlayOpen: false },
      expected: { rail: 'shown', panel: 'hidden' },
    },
    {
      name: 'medium opens the panel over the content',
      input: { band: ShellBand.Medium, hasPanel: true, panelHidden: false, overlayOpen: true },
      expected: { rail: 'shown', panel: 'overlay' },
    },
    {
      name: 'medium ignores the remembered hide',
      input: { band: ShellBand.Medium, hasPanel: true, panelHidden: true, overlayOpen: true },
      expected: { rail: 'shown', panel: 'overlay' },
    },
    {
      name: 'narrow folds the rail and the panel',
      input: { band: ShellBand.Narrow, hasPanel: true, panelHidden: false, overlayOpen: false },
      expected: { rail: 'hidden', panel: 'hidden' },
    },
    {
      name: 'narrow opens the rail and the panel together',
      input: { band: ShellBand.Narrow, hasPanel: true, panelHidden: false, overlayOpen: true },
      expected: { rail: 'overlay', panel: 'overlay' },
    },
    {
      name: 'wide with no panel',
      input: { band: ShellBand.Wide, hasPanel: false, panelHidden: false, overlayOpen: false },
      expected: { rail: 'shown', panel: 'none' },
    },
    {
      name: 'medium with no panel',
      input: { band: ShellBand.Medium, hasPanel: false, panelHidden: false, overlayOpen: true },
      expected: { rail: 'shown', panel: 'none' },
    },
    {
      name: 'narrow with no panel folds the rail alone',
      input: { band: ShellBand.Narrow, hasPanel: false, panelHidden: false, overlayOpen: false },
      expected: { rail: 'hidden', panel: 'none' },
    },
    {
      name: 'narrow with no panel opens the rail alone',
      input: { band: ShellBand.Narrow, hasPanel: false, panelHidden: false, overlayOpen: true },
      expected: { rail: 'overlay', panel: 'none' },
    },
  ];

  it.each(rows)('$name', ({ input, expected }) => {
    expect(shellLayout(input)).toEqual(expected);
  });
});
