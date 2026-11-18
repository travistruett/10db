/** The window's width class, which decides how much of the frame is drawn beside the content. */
export const ShellBand = { Wide: 'wide', Medium: 'medium', Narrow: 'narrow' } as const;
export type ShellBand = (typeof ShellBand)[keyof typeof ShellBand];

/** The width at which the panel column fits beside the content. */
export const WIDE_FROM_PX = 1000;
/** The width at which the rail fits beside the content. */
export const MEDIUM_FROM_PX = 640;

export function shellBand(windowWidth: number): ShellBand {
  if (windowWidth >= WIDE_FROM_PX) return ShellBand.Wide;
  if (windowWidth >= MEDIUM_FROM_PX) return ShellBand.Medium;
  return ShellBand.Narrow;
}

export interface ShellLayout {
  /** Shown in its column, folded behind the sidebar button until opened (`overlay`), or folded away. */
  readonly rail: 'shown' | 'overlay' | 'hidden';
  /** A column, a sheet over the content, folded away, or absent because the section has none. */
  readonly panel: 'column' | 'overlay' | 'hidden' | 'none';
}

/** What the frame draws for a width band, whether the section has a panel, and what the builder asked for. */
export function shellLayout(input: {
  readonly band: ShellBand;
  readonly hasPanel: boolean;
  /** The builder hid the panel (wide only; remembered per section). */
  readonly panelHidden: boolean;
  /** The sidebar button or the shortcut opened the overlay (medium and narrow). */
  readonly overlayOpen: boolean;
}): ShellLayout {
  const folded = input.overlayOpen ? 'overlay' : 'hidden';
  switch (input.band) {
    case ShellBand.Wide:
      return {
        rail: 'shown',
        panel: !input.hasPanel ? 'none' : input.panelHidden ? 'hidden' : 'column',
      };
    case ShellBand.Medium:
      return { rail: 'shown', panel: input.hasPanel ? folded : 'none' };
    case ShellBand.Narrow:
      return { rail: folded, panel: input.hasPanel ? folded : 'none' };
  }
}
