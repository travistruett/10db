import type { TaskId } from '@10db/contracts';

// Pick on Page spec §5: the Preview's "3 in Settings ›" brings 10db forward on that page's picks, never
// its input, so nothing the builder is typing lands in the draft. The ask is held for a moment, for the
// window focus it causes, which would otherwise hand the cursor to the composer.

const HOLD_MS = 2_000;

let asked: { readonly taskId: TaskId; readonly until: number } | null = null;
const listeners = new Set<(taskId: TaskId) => void>();

/** The page whose picks should take the cursor as the window comes forward. */
export function askPicksFocus(taskId: TaskId, now = Date.now()): void {
  asked = { taskId, until: now + HOLD_MS };
  for (const listener of listeners) listener(taskId);
}

/** Whether a window focus now was the Preview's, which hands the cursor to the picks, not the input. */
export function focusIsPreviews(now = Date.now()): boolean {
  return asked !== null && asked.until > now;
}

/** Listens for asks; the workspace selects the page and moves the cursor to its picks. */
export function onPicksFocus(listener: (taskId: TaskId) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
