import type { TaskId } from '@10db/contracts';
import type { PageStatus } from './page-status';
import { queueRank } from './queue-order';

// Workbench spec §4.3, §4.6: J and K move through the queue and Enter selects; N goes to the next page
// that waits on the builder; ⌘L copies the shown page's link; Escape leaves the composer for the queue.
// Letters typed into the composer are text, and a region marked with `KEYS_IGNORE_ATTRIBUTE` keeps its
// own keys. ⌘↩ is the composer's.

/** Marks a region that handles its own keys; the Workbench's keys skip it. */
export const KEYS_IGNORE_ATTRIBUTE = 'data-workbench-keys-ignore';

export const WorkbenchKey = {
  Next: 'next',
  Previous: 'previous',
  NextWaiting: 'next_waiting',
  CopyLink: 'copy_link',
  LeaveField: 'leave_field',
} as const;
export type WorkbenchKey = (typeof WorkbenchKey)[keyof typeof WorkbenchKey];

export interface KeyPress {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export interface KeyPlace {
  /** The key landed in a field: a letter there is text. */
  readonly editing: boolean;
  /** The key landed inside a region that keeps its own keys. */
  readonly ignored: boolean;
  /** A dialog or menu is open over the view. */
  readonly dialog: boolean;
}

const LETTERS: Readonly<Record<string, WorkbenchKey>> = {
  j: WorkbenchKey.Next,
  k: WorkbenchKey.Previous,
  n: WorkbenchKey.NextWaiting,
};

/** What a key press does in the Workbench, or null when it is left to where it landed. */
export function workbenchKey(press: KeyPress, place: KeyPlace): WorkbenchKey | null {
  if (place.ignored || place.dialog) return null;
  const command = press.metaKey || press.ctrlKey;
  // ⌘L types nothing, so it copies from the composer too.
  if (command && !press.shiftKey && !press.altKey && press.key.toLowerCase() === 'l')
    return WorkbenchKey.CopyLink;
  if (command || press.altKey || press.shiftKey) return null;
  if (place.editing) return press.key === 'Escape' ? WorkbenchKey.LeaveField : null;
  return LETTERS[press.key] ?? null;
}

/** The row a move lands on, kept within the queue; from no row, the first. */
export function stepIndex(from: number | null, delta: 1 | -1, count: number): number | null {
  if (count === 0) return null;
  if (from === null) return 0;
  return Math.min(count - 1, Math.max(0, from + delta));
}

/**
 * The next page after `current` that waits on the builder (ranks 1 to 3), going round the queue; null
 * when no other page waits.
 */
export function nextWaiting(
  rows: readonly { readonly taskId: TaskId; readonly status: PageStatus }[],
  current: TaskId | null,
): TaskId | null {
  const at = rows.findIndex((row) => row.taskId === current);
  const after = [...rows.slice(at + 1), ...rows.slice(0, Math.max(at, 0))];
  return after.find((row) => queueRank(row.status) < 4)?.taskId ?? null;
}
