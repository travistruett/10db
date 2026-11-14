import { useEffect, useRef } from 'react';
import { escapeIsTaken } from '../../conversation/escape';

export interface ShapeKeys {
  /** ⌘⇧↩ (Ctrl⇧↩ off a Mac): Propose or Propose Again, from anywhere on the screen, the input included. */
  readonly onPropose: () => void;
  /** Esc while Claude is answering. */
  readonly onStop: () => void;
  readonly answering: boolean;
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
