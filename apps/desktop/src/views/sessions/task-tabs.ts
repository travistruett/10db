import { ProjectId, TaskId } from '@10db/contracts';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';

// The task tabs of this window (sessions UI §8.2): a task Do It made takes a tab in the strip. The tabs live
// in the window, so no migration; a cleared store loses the tab, never the task, which the Board, the
// Workbench, the Inbox and the chat's row reopen. Pure functions over the list, and one store over them.

export const TASK_TABS_KEY = 'tendb.sessions.tasks';

/** Where a task works: its own copy, or the one page of a pass of one in Your folder. */
export const TaskTabPlace = { Copy: 'copy', Pass: 'pass' } as const;
export type TaskTabPlace = (typeof TaskTabPlace)[keyof typeof TaskTabPlace];

export const TaskTab = z.object({
  taskId: TaskId,
  projectId: ProjectId,
  /** The title it had when it opened; the tab reads the task's own once it is read. */
  title: z.string(),
  place: z.enum(TaskTabPlace),
  /** Where the tab sits in the strip. */
  position: z.int().nonnegative(),
});
export type TaskTab = z.infer<typeof TaskTab>;

/** The strip's key of a task's tab. */
export const taskTabKey = (taskId: string): string => `task:${taskId}`;

/** `entry` added, or the tab already open for the task kept where it is. */
export function openTaskTab(tabs: readonly TaskTab[], entry: TaskTab): readonly TaskTab[] {
  return tabs.some((t) => t.taskId === entry.taskId) ? tabs : [...tabs, entry];
}

export function closeTaskTab(tabs: readonly TaskTab[], taskId: string): readonly TaskTab[] {
  return tabs.filter((t) => t.taskId !== taskId);
}

/** A store that does not parse reads as empty. */
export function parseTaskTabs(raw: string | null): readonly TaskTab[] {
  if (raw === null) return [];
  try {
    const parsed = z.array(TaskTab).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

let held: readonly TaskTab[] | null = null;
const listeners = new Set<() => void>();

function current(): readonly TaskTab[] {
  held ??= parseTaskTabs(localStorage.getItem(TASK_TABS_KEY));
  return held;
}

function replace(next: readonly TaskTab[]): void {
  held = next;
  try {
    localStorage.setItem(TASK_TABS_KEY, JSON.stringify(next));
  } catch {
    // The tabs are a convenience; the tasks are the daemon's.
  }
  for (const listener of listeners) listener();
}

/** The window's task tabs. */
export const taskTabs = {
  list: current,
  open: (entry: TaskTab): void => {
    replace(openTaskTab(current(), entry));
  },
  close: (taskId: string): TaskTab | null => {
    const entry = current().find((t) => t.taskId === taskId) ?? null;
    if (entry !== null) replace(closeTaskTab(current(), taskId));
    return entry;
  },
  /** Forgets what was read: the next read goes to storage again. */
  reset: (): void => {
    held = null;
    for (const listener of listeners) listener();
  },
};

export function useTaskTabs(): readonly TaskTab[] {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, current);
}
