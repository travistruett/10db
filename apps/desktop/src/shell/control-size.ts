/**
 * Sizes 10db adds to Mantine's own, given to a control's `size` prop and drawn by `theme.ts`.
 * `Toolbar` is a control on a page's tab row (`PageIntro` with `PageTabs`): 26 px tall with 12 px type, shorter
 * and lighter than the 36 px tabs, so it sits centred on their text and clear of the hairline under them.
 */
export const ControlSize = { Toolbar: 'toolbar' } as const;
export type ControlSize = (typeof ControlSize)[keyof typeof ControlSize];

/** How tall a `ControlSize.Toolbar` control is, in px. */
export const TOOLBAR_CONTROL_PX = 26;
