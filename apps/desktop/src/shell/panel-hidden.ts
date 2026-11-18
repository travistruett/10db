import { useSyncExternalStore } from 'react';
import type { RailSection } from './rail-items';

// Whether the builder hid a section's panel, kept per section so it is still hidden after a restart.
// A cleared or blocked store shows the panel; the choice then lasts only until the window closes.

const HIDDEN = 'hidden';
const keyOf = (section: RailSection): string => `tendb.shell.panel.${section}`;

const listeners = new Set<() => void>();
const inMemory = new Map<RailSection, boolean>();

function read(section: RailSection): boolean {
  try {
    const stored = window.localStorage.getItem(keyOf(section));
    return stored === null ? (inMemory.get(section) ?? false) : stored === HIDDEN;
  } catch {
    return inMemory.get(section) ?? false;
  }
}

function write(section: RailSection, hidden: boolean): void {
  inMemory.set(section, hidden);
  try {
    if (hidden) window.localStorage.setItem(keyOf(section), HIDDEN);
    else window.localStorage.removeItem(keyOf(section));
  } catch {
    // The in-memory choice stands.
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

/** Whether the section's panel is hidden, and how to flip that. Sections with no section pass null. */
export function usePanelHidden(section: RailSection | null): {
  readonly hidden: boolean;
  readonly toggle: () => void;
} {
  const hidden = useSyncExternalStore(subscribe, () => (section === null ? false : read(section)));
  return {
    hidden,
    toggle: () => {
      if (section !== null) write(section, !read(section));
    },
  };
}
