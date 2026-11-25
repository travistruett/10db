/**
 * The content widths (DESIGN.md, Content width): a view's content grows to one of them, then centres. Reading
 * is for prose and conversation, Page for pages of rows, tables and figures; a workspace whose content is the
 * work (the Board, an open Workbench pass) takes neither and fills the window. A view says
 * `<Container size={ContentWidth.Page}>`, which the theme maps to the width below.
 */
export const ContentWidth = { Reading: 'reading', Page: 'page' } as const;
export type ContentWidth = (typeof ContentWidth)[keyof typeof ContentWidth];

/** Each content width in px: the one place they are set. */
export const CONTENT_WIDTH_PX: Readonly<Record<ContentWidth, number>> = {
  [ContentWidth.Reading]: 720,
  [ContentWidth.Page]: 1080,
};

export function isContentWidth(size: unknown): size is ContentWidth {
  return size === ContentWidth.Reading || size === ContentWidth.Page;
}
