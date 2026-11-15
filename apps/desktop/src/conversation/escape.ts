// Esc and Enter as the conversation screens share them: what owns Esc (an open layer, a form, a waiting
// card), and the key that sends.

/** Marks a form that cancels on Esc itself, so a key pressed inside it is left to it. */
export const OWNS_ESCAPE_ATTRIBUTE = 'data-owns-escape';

/** Marks a waiting card, whose note and options keep Esc (sessions UI spec §7.7). */
export const WAITING_CARD_ATTRIBUTE = 'data-waiting-card';

/**
 * True when Esc belongs to something open on top of the screen: a modal, a menu, a select whose list is
 * showing, or focus inside a waiting card. Closed ones are not in the page (or, for a select, not
 * `aria-expanded`).
 */
export function escapeIsTaken(event: KeyboardEvent): boolean {
  return (
    event.defaultPrevented ||
    document.querySelector(
      '[role="dialog"], [role="menu"], [aria-expanded="true"][aria-haspopup]',
    ) !== null ||
    (document.activeElement?.closest(`[${WAITING_CARD_ATTRIBUTE}]`) ?? null) !== null
  );
}

/**
 * True when the key landed inside a form that answers Esc itself. That form hears the key only on
 * the way back up, after a capture listener, so the listener has to ask where the key landed.
 */
export function escapeHasOwner(event: KeyboardEvent): boolean {
  return (
    event.target instanceof Element && event.target.closest(`[${OWNS_ESCAPE_ATTRIBUTE}]`) !== null
  );
}

/** Enter sends from the input; Shift+Enter is a new line, and ⌘↩ and Ctrl+↩ still send. */
export function isSendKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}): boolean {
  return event.key === 'Enter' && !event.shiftKey && event.altKey !== true;
}

/**
 * True for a keydown that belongs to an IME composition: its Enter picks a candidate and is never a
 * send. Safari ends a composition with a keydown whose `isComposing` is already false and whose
 * keyCode is 229.
 */
export function isComposing(event: {
  keyCode: number;
  nativeEvent: { isComposing: boolean };
}): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
