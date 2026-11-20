import { useSyncExternalStore } from 'react';

// Whether the builder opened or closed a session's Plan panel, kept for the window as Changes' choice is.
// A session with a plan opens it until they close it. The Sessions screen reads it too: an open panel
// folds the sessions list to the rail.

const chosen = new Map<string, boolean>();
const listeners = new Set<() => void>();

const changed = (): void => {
  for (const listener of listeners) listener();
};

export const planChoice = {
  /** The builder's choice for the session, or null while they have made none. */
  get: (key: string): boolean | null => chosen.get(key) ?? null,
  set: (key: string, open: boolean): void => {
    chosen.set(key, open);
    changed();
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Whether the panel is open for `key`: the builder's choice, else open for a session with a plan. */
export function usePlanOpen(key: string | null, hasPlan: boolean): boolean {
  return useSyncExternalStore(planChoice.subscribe, () =>
    key === null || !hasPlan ? false : (planChoice.get(key) ?? true),
  );
}
