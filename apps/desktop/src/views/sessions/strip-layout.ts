import { useMediaQuery } from '@mantine/hooks';

/** How the strip is drawn at a window width (sessions UI spec §13.2). */
export type StripLayout = 'full' | 'compact' | 'switcher';

/** The widest window that is compact, and the widest that is a switcher. */
export const COMPACT_MAX = 899;
export const SWITCHER_MAX = 639;

/** Full tabs from 900 px; unselected tabs as tile and state from 640 to 899; one switcher under 640. */
export function stripLayout(width: number): StripLayout {
  if (width > COMPACT_MAX) return 'full';
  return width > SWITCHER_MAX ? 'compact' : 'switcher';
}

/** The layout of the window now, read through the same media queries the pure function describes. */
export function useStripLayout(): StripLayout {
  const switcher = useMediaQuery(`(max-width: ${String(SWITCHER_MAX)}px)`);
  const compact = useMediaQuery(`(max-width: ${String(COMPACT_MAX)}px)`);
  return switcher ? 'switcher' : compact ? 'compact' : 'full';
}
