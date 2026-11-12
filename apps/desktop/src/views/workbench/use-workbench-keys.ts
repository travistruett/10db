import { useEffect, useRef } from 'react';
import { KEYS_IGNORE_ATTRIBUTE, workbenchKey, type WorkbenchKey } from './workbench-keys';

/** What each Workbench key does where this hook is used; a key with no handler is left alone. */
export type WorkbenchKeyHandlers = Partial<Record<WorkbenchKey, () => void>>;

function editing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/** Listens for the Workbench's keys on the document and calls the handlers given for them. */
export function useWorkbenchKeys(handlers: WorkbenchKeyHandlers): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const key = workbenchKey(event, {
        editing: editing(event.target),
        ignored:
          event.target instanceof Element &&
          event.target.closest(`[${KEYS_IGNORE_ATTRIBUTE}]`) !== null,
        dialog: document.querySelector('[role="dialog"], [role="menu"]') !== null,
      });
      const handler = key === null ? undefined : latest.current[key];
      if (handler === undefined) return;
      event.preventDefault();
      handler();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
