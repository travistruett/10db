// Shape spec §4, D7. The conversation and the Proposed sidebar share the view's width: a draggable
// divider, remembered per person, with a floor for each side. Under 1100 px of content the sidebar
// is a drawer over the chat instead.

export const CHAT_MIN = 420;
export const SIDEBAR_MIN = 480;
export const DRAWER_BELOW = 1100;
export const DEFAULT_CHAT_SHARE = 0.45;

export type SplitLayout =
  | {
      readonly mode: 'split';
      /** The chat's width in px; null before the width is measured, when the share is a percentage. */
      readonly chat: number | null;
    }
  | { readonly mode: 'drawer' };

/** The layout for a content `width` and the chat's remembered `share` of it. */
export function splitLayout(width: number, share: number): SplitLayout {
  if (width <= 0) return { mode: 'split', chat: null };
  if (width < DRAWER_BELOW) return { mode: 'drawer' };
  const wanted = Math.round(width * share);
  return { mode: 'split', chat: Math.min(Math.max(wanted, CHAT_MIN), width - SIDEBAR_MIN) };
}

/** The share a divider dragged to `chatPx` of `width` leaves the chat, within both floors. */
export function chatShareAfterDrag(chatPx: number, width: number): number {
  if (width <= 0) return DEFAULT_CHAT_SHARE;
  const clamped = Math.min(Math.max(chatPx, CHAT_MIN), width - SIDEBAR_MIN);
  return clamped / width;
}
