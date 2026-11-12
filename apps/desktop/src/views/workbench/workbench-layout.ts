// Workbench spec §4.3: the Workbench usually sits in a narrow window beside the builder's browser, so it
// lays out by the window's width. Narrow: the queue is a strip across the top and the thread fills the
// rest. Wide: the queue on the left, the thread on the right.

export const WorkbenchLayout = { Narrow: 'narrow', Wide: 'wide' } as const;
export type WorkbenchLayout = (typeof WorkbenchLayout)[keyof typeof WorkbenchLayout];

/** From this window width the queue and the thread sit side by side. */
export const WIDE_MIN_PX = 900;

/** The layout for a window `width` in px; a window not yet measured reads 0 and lays out narrow. */
export function workbenchLayout(width: number): WorkbenchLayout {
  return width >= WIDE_MIN_PX ? WorkbenchLayout.Wide : WorkbenchLayout.Narrow;
}
