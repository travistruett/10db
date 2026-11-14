import { useEffect, useRef } from 'react';
import { escapeHasOwner, escapeIsTaken } from '../../conversation/escape';
import { sessionKey, type SessionKey } from './session-keys';

/**
 * Sessions' keys, heard on the document while the screen is mounted. `onKey` answers whether it took
 * the key; a key taken has its default action stopped, so ⌘W never closes the window nor ⌃Tab leaves the page.
 */
export function useSessionKeys(onKey: (key: SessionKey) => boolean): void {
  const latest = useRef(onKey);
  useEffect(() => {
    latest.current = onKey;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = sessionKey(
        {
          key: event.key,
          meta: event.metaKey,
          shift: event.shiftKey,
          ctrl: event.ctrlKey,
          alt: event.altKey,
        },
        { onSessions: true, escapeTaken: escapeIsTaken(event) || escapeHasOwner(event) },
      );
      if (key === null) return;
      if (latest.current(key)) event.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
