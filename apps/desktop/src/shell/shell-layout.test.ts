import { describe, expect, it } from 'vitest';
import { ShellBand, shellBand, shellLayout, SidebarSheet, type ShellLayout } from './shell-layout';

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
  type Input = Parameters<typeof shellLayout>[0];
  const base: Input = {
    band: ShellBand.Wide,
    hasPanel: true,
    panelHidden: false,
    labels: true,
    sheet: null,
  };
  const rows: readonly {
    readonly name: string;
    readonly input: Input;
    readonly expected: ShellLayout;
  }[] = [
    {
      name: 'wide with labels and a panel shows a labelled rail and the panel',
      input: base,
      expected: { column: 'labelled', rail: 'column', labels: true, panel: 'column' },
    },
    {
      name: 'wide with labels off shows the icons-only rail',
      input: { ...base, labels: false },
      expected: { column: 'icons', rail: 'column', labels: false, panel: 'column' },
    },
    {
      name: 'wide with a panel the builder hid keeps the rail only',
      input: { ...base, panelHidden: true },
      expected: { column: 'labelled', rail: 'column', labels: true, panel: 'hidden' },
    },
    {
      name: 'wide ignores a stale sheet request',
      input: { ...base, sheet: SidebarSheet.Sections },
      expected: { column: 'labelled', rail: 'column', labels: true, panel: 'column' },
    },
    {
      name: 'wide with no panel',
      input: { ...base, hasPanel: false },
      expected: { column: 'labelled', rail: 'column', labels: true, panel: 'none' },
    },
    {
      name: 'medium keeps the icons rail whatever the labels preference says, and folds the panel',
      input: { ...base, band: ShellBand.Medium },
      expected: { column: 'icons', rail: 'column', labels: false, panel: 'hidden' },
    },
    {
      name: 'medium opens the labelled sidebar as a sheet with the panel beside it',
      input: { ...base, band: ShellBand.Medium, sheet: SidebarSheet.Sections },
      expected: { column: 'icons', rail: 'sheet', labels: true, panel: 'sheet' },
    },
    {
      name: 'medium opens the panel alone beside the icons rail',
      input: { ...base, band: ShellBand.Medium, sheet: SidebarSheet.Panel },
      expected: { column: 'icons', rail: 'column', labels: false, panel: 'sheet' },
    },
    {
      name: 'medium ignores the remembered hide when a sheet opens',
      input: { ...base, band: ShellBand.Medium, panelHidden: true, sheet: SidebarSheet.Panel },
      expected: { column: 'icons', rail: 'column', labels: false, panel: 'sheet' },
    },
    {
      name: 'medium with no panel opens the labelled sidebar alone',
      input: { ...base, band: ShellBand.Medium, hasPanel: false, sheet: SidebarSheet.Sections },
      expected: { column: 'icons', rail: 'sheet', labels: true, panel: 'none' },
    },
    {
      name: 'medium with no panel has nothing for the panel key to open',
      input: { ...base, band: ShellBand.Medium, hasPanel: false, sheet: SidebarSheet.Panel },
      expected: { column: 'icons', rail: 'column', labels: false, panel: 'none' },
    },
    {
      name: 'narrow folds the sidebar away',
      input: { ...base, band: ShellBand.Narrow },
      expected: { column: 'none', rail: 'hidden', labels: false, panel: 'hidden' },
    },
    {
      name: 'narrow opens the icons rail and the panel together for a section with a panel',
      input: { ...base, band: ShellBand.Narrow, sheet: SidebarSheet.Sections },
      expected: { column: 'none', rail: 'sheet', labels: false, panel: 'sheet' },
    },
    {
      name: 'narrow opens the panel key the same way',
      input: { ...base, band: ShellBand.Narrow, sheet: SidebarSheet.Panel },
      expected: { column: 'none', rail: 'sheet', labels: false, panel: 'sheet' },
    },
    {
      name: 'narrow with no panel folds the rail alone',
      input: { ...base, band: ShellBand.Narrow, hasPanel: false },
      expected: { column: 'none', rail: 'hidden', labels: false, panel: 'none' },
    },
    {
      name: 'narrow with no panel opens the labelled rail alone',
      input: { ...base, band: ShellBand.Narrow, hasPanel: false, sheet: SidebarSheet.Sections },
      expected: { column: 'none', rail: 'sheet', labels: true, panel: 'none' },
    },
  ];

  it.each(rows)('$name', ({ input, expected }) => {
    expect(shellLayout(input)).toEqual(expected);
  });
});
