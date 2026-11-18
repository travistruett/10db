import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, PANEL_WIDTH } from './shell-layout';

// How wide the builder dragged the section's panel, one width for every section, kept across restarts.
// A cleared or blocked store means the default; the width then lasts only until the window closes.

const KEY = 'tendb.shell.panelWidth';

/** A stored width is read from disk: anything that is not a whole number of pixels in range is ignored. */
const StoredWidth = z.coerce.number().int().min(PANEL_MIN_WIDTH).max(PANEL_MAX_WIDTH);

const listeners = new Set<() => void>();
let inMemory = PANEL_WIDTH;

function read(): number {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === null) return inMemory;
    const parsed = StoredWidth.safeParse(stored);
    return parsed.success ? parsed.data : PANEL_WIDTH;
  } catch {
    return inMemory;
  }
}

function write(width: number): void {
  const clamped = Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)));
  if (clamped === read()) return;
  inMemory = clamped;
  try {
    if (clamped === PANEL_WIDTH) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, String(clamped));
  } catch {
    // The in-memory width stands.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** The panel's width in pixels, and how to set it (clamped to the panel's range). */
export function usePanelWidth(): {
  readonly width: number;
  readonly setWidth: (px: number) => void;
} {
  const width = useSyncExternalStore(subscribe, read);
  return { width, setWidth: write };
}

/** A width in pixels as the splitter takes it: a fixed size. */
export function px(width: number): `${number}px` {
  // The splitter's type names a number before the unit, which String() would widen to any string.
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
  return `${width}px`;
}
