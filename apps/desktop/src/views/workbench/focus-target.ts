import type { TaskId } from '@10db/contracts';
import type { PageStatus } from './page-status';
import { queueRank } from './queue-order';

// Workbench spec §4.3, design review D12: getting back to the right page when 10db's window gains
// focus. A ready notification shown in the last 10 seconds and not acted on is taken as the one the
// builder clicked: its page is selected, the later of two winning, since it is the one on screen. Focus
// by other means selects the oldest page that waits on the builder, but only when the selected page
// waits on nothing. Neither ever takes the builder away from a draft.

/** How long after a ready notification a window focus counts as its click. */
export const NOTIFIED_FOCUS_MS = 10_000;

/** A ready notification 10db showed. */
export interface ShownNotification {
  readonly taskId: TaskId;
  /** When it was shown, in epoch ms. */
  readonly at: number;
  /** Its click was read, so the page was selected already. */
  readonly acted: boolean;
}

export interface FocusInput {
  /** When the window gained focus, in epoch ms. */
  readonly now: number;
  readonly notified: readonly ShownNotification[];
  /** The pass's pages in queue order. */
  readonly rows: readonly { readonly taskId: TaskId; readonly status: PageStatus }[];
  readonly selected: TaskId | null;
  /** The pages whose composer holds a draft. */
  readonly drafts: ReadonlySet<TaskId>;
}

/** The page to select as the window gains focus, or null when nothing moves. */
export function focusTarget(input: FocusInput): TaskId | null {
  const { now, notified, rows, selected, drafts } = input;
  if (selected !== null && drafts.has(selected)) return null;
  const inPass = new Set(rows.map((row) => row.taskId));
  const clicked = notified
    .filter((n) => !n.acted && now - n.at <= NOTIFIED_FOCUS_MS && inPass.has(n.taskId))
    .reduce<ShownNotification | null>(
      (latest, n) => (latest === null || n.at > latest.at ? n : latest),
      null,
    );
  if (clicked !== null) return clicked.taskId;
  const current = rows.find((row) => row.taskId === selected);
  if (current !== undefined && queueRank(current.status) < 4) return null;
  return rows.find((row) => queueRank(row.status) < 4)?.taskId ?? null;
}
