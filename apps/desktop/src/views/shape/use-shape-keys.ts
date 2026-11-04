import { useEffect, useRef } from 'react';

export interface ShapeKeys {
  /** ⌘⇧↩ (Ctrl⇧↩ off a Mac): Propose or Propose Again, from anywhere on the screen, the input included. */
  readonly onPropose: () => void;
  /** Esc while Claude is answering. */
  readonly onStop: () => void;
  readonly answering: boolean;
}

/**
 * True when Esc belongs to something open on top of the screen: a modal, a menu, or a select whose
 * list is showing. Closed ones are not in the page (or, for a select, not `aria-expanded`).
 */
export function escapeIsTaken(event: KeyboardEvent): boolean {
  return (
    event.defaultPrevented ||
    document.querySelector(
      '[role="dialog"], [role="menu"], [aria-expanded="true"][aria-haspopup]',
    ) !== null
  );
}

/** Marks a form that cancels on Esc itself, so a key pressed inside it is left to it. */
export const OWNS_ESCAPE_ATTRIBUTE = 'data-owns-escape';

/**
 * True when the key landed inside a form that answers Esc itself. That form hears the key only on
 * the way back up, after a capture listener, so the listener has to ask where the key landed.
 */
export function escapeHasOwner(event: KeyboardEvent): boolean {
  return (
    event.target instanceof Element && event.target.closest(`[${OWNS_ESCAPE_ATTRIBUTE}]`) !== null
  );
}

/** ⌘↩ is the input's (`isSendKey`); the screen's own keys are ⌘⇧↩ and Esc. */
export function useShapeKeys(keys: ShapeKeys): void {
  const latest = useRef(keys);
  useEffect(() => {
    latest.current = keys;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const { onPropose, onStop, answering } = latest.current;
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.shiftKey) {
        // A modal (Convert, Remove Draft Goal, Withdraw Decision) owns the keyboard: no Propose
        // turn gets queued behind it.
        if (document.querySelector('[role="dialog"]') !== null) return;
        event.preventDefault();
        onPropose();
      } else if (event.key === 'Escape' && answering && !escapeIsTaken(event)) {
        event.preventDefault();
        onStop();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}

/** ⌘↩ sends from the input. */
export function isSendKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey;
}
