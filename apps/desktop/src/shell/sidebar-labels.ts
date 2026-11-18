import { useSyncExternalStore } from 'react';

// Whether the builder wants the sidebar's rail labelled (the default) or icons only, kept across restarts.
// A cleared or blocked store means labelled; the choice then lasts only until the window closes.

const KEY = 'tendb.shell.labels';
const ICONS_ONLY = 'icons';

const listeners = new Set<() => void>();
let inMemory = true;

function read(): boolean {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored !== ICONS_ONLY;
  } catch {
    return inMemory;
  }
}

function write(labels: boolean): void {
  inMemory = labels;
  try {
    if (labels) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, ICONS_ONLY);
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

/** Whether the rail is labelled, and how to flip that. */
export function useSidebarLabels(): { readonly labels: boolean; readonly toggle: () => void } {
  const labels = useSyncExternalStore(subscribe, read);
  return {
    labels,
    toggle: () => {
      write(!read());
    },
  };
}
