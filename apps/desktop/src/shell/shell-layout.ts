/** The window's width class, which decides how much of the frame is drawn beside the content. */
export const ShellBand = { Wide: 'wide', Medium: 'medium', Narrow: 'narrow' } as const;
export type ShellBand = (typeof ShellBand)[keyof typeof ShellBand];

/** The width at which the panel column fits beside the content. */
export const WIDE_FROM_PX = 1000;
/** The width of a section's panel until the builder drags it, in the app's frame and in a picture of a screen. */
export const PANEL_WIDTH = 340;
/** How narrow and how wide the builder can drag the panel. */
export const PANEL_MIN_WIDTH = 240;
export const PANEL_MAX_WIDTH = 480;
/** The width at which the rail fits beside the content. */
export const MEDIUM_FROM_PX = 640;

export function shellBand(windowWidth: number): ShellBand {
  if (windowWidth >= WIDE_FROM_PX) return ShellBand.Wide;
  if (windowWidth >= MEDIUM_FROM_PX) return ShellBand.Medium;
  return ShellBand.Narrow;
}

/** What the builder opened over the content: the whole sidebar (⇧⌘S) or the section's panel (⌘\). */
export const SidebarSheet = { Sections: 'sections', Panel: 'panel' } as const;
export type SidebarSheet = (typeof SidebarSheet)[keyof typeof SidebarSheet];

export interface ShellLayout {
  /** The width the rail holds beside the content: labelled, icons only, or none. */
  readonly column: 'labelled' | 'icons' | 'none';
  /** In its column, standing over the content as a sheet, or folded away. */
  readonly rail: 'column' | 'sheet' | 'hidden';
  /** Whether the rail as drawn carries its labels. */
  readonly labels: boolean;
  /** A column, a sheet over the content, folded away, or absent because the section has none. */
  readonly panel: 'column' | 'sheet' | 'hidden' | 'none';
}

/** What the frame draws for a width band, whether the section has a panel, and what the builder asked for. */
export function shellLayout(input: {
  readonly band: ShellBand;
  readonly hasPanel: boolean;
  /** The builder hid the panel (wide only; remembered per section). */
  readonly panelHidden: boolean;
  /** The builder's choice of a labelled or an icons-only rail (applies wide only; remembered). */
  readonly labels: boolean;
  /** What the sidebar key or the panel key opened over the content (medium and narrow). */
  readonly sheet: SidebarSheet | null;
}): ShellLayout {
  const { band, hasPanel, panelHidden, labels, sheet } = input;
  switch (band) {
    case ShellBand.Wide:
      return {
        column: labels ? 'labelled' : 'icons',
        rail: 'column',
        labels,
        panel: !hasPanel ? 'none' : panelHidden ? 'hidden' : 'column',
      };
    case ShellBand.Medium: {
      const panel = !hasPanel ? 'none' : sheet === null ? 'hidden' : 'sheet';
      return sheet === SidebarSheet.Sections
        ? { column: 'icons', rail: 'sheet', labels: true, panel }
        : { column: 'icons', rail: 'column', labels: false, panel };
    }
    case ShellBand.Narrow: {
      const panel = !hasPanel ? 'none' : sheet === null ? 'hidden' : 'sheet';
      // The panel key has nothing to open where the section has no panel, as on a medium window.
      if (sheet === null || (sheet === SidebarSheet.Panel && !hasPanel)) {
        return { column: 'none', rail: 'hidden', labels: false, panel };
      }
      return {
        column: 'none',
        rail: 'sheet',
        labels: !hasPanel && sheet === SidebarSheet.Sections,
        panel,
      };
    }
  }
}
