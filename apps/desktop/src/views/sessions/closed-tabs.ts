import { ChatId, ProjectId, TaskId } from '@10db/contracts';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';

// The last tabs the builder closed, newest first, each with the place it held (sessions UI spec §5.6):
// ⌘⇧T, All Tabs and the Inbox's Open Session reopen a tab where it was. Kept per window in
// `localStorage` (`tendb.sessions.closed`).

export const CLOSED_TABS_KEY = 'tendb.sessions.closed';

/** How many closed tabs are remembered. */
export const CLOSED_LIMIT = 5;

export const ClosedChat = z.object({
  chatId: ChatId,
  projectId: ProjectId,
  /** The title it had, for All Tabs. */
  title: z.string(),
  position: z.int().nonnegative(),
  /** The tab was archived, not only closed: reopening it unarchives it first. */
  archived: z.boolean().optional(),
});
export type ClosedChat = z.infer<typeof ClosedChat>;

/** A task's tab closed: reopening it puts the tab back, and the task itself was never touched. */
export const ClosedTask = z.object({
  taskId: TaskId,
  projectId: ProjectId,
  title: z.string(),
  place: z.enum(['copy', 'pass']),
  position: z.int().nonnegative(),
});
export type ClosedTask = z.infer<typeof ClosedTask>;

export const ClosedTab = z.union([ClosedChat, ClosedTask]);
export type ClosedTab = z.infer<typeof ClosedTab>;

/** The id a closed tab is kept under: its chat's or its task's. */
export function closedId(entry: ClosedTab): string {
  return 'chatId' in entry ? entry.chatId : entry.taskId;
}

const Stored = z.array(ClosedTab);

/** `entry` on top of the stack; a tab already in it moves to the top, and only the newest five stay. */
export function pushClosed(stack: readonly ClosedTab[], entry: ClosedTab): readonly ClosedTab[] {
  return [entry, ...stack.filter((held) => closedId(held) !== closedId(entry))].slice(
    0,
    CLOSED_LIMIT,
  );
}

/** The newest closed tab and the stack without it. */
export function popClosed(stack: readonly ClosedTab[]): {
  readonly entry: ClosedTab | null;
  readonly rest: readonly ClosedTab[];
} {
  return { entry: stack[0] ?? null, rest: stack.slice(1) };
}

/** The entry for the chat or task `id`, wherever it sits, and the stack without it. */
export function takeClosed(
  stack: readonly ClosedTab[],
  id: string,
): { readonly entry: ClosedTab | null; readonly rest: readonly ClosedTab[] } {
  return {
    entry: stack.find((held) => closedId(held) === id) ?? null,
    rest: stack.filter((held) => closedId(held) !== id),
  };
}

/** A store that does not parse reads as empty. */
export function parseClosed(raw: string | null): readonly ClosedTab[] {
  if (raw === null) return [];
  try {
    const parsed = Stored.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.slice(0, CLOSED_LIMIT) : [];
  } catch {
    return [];
  }
}

let held: readonly ClosedTab[] | null = null;
const listeners = new Set<() => void>();

function current(): readonly ClosedTab[] {
  held ??= parseClosed(localStorage.getItem(CLOSED_TABS_KEY));
  return held;
}

function replace(next: readonly ClosedTab[]): void {
  held = next;
  try {
    localStorage.setItem(CLOSED_TABS_KEY, JSON.stringify(next));
  } catch {
    // The stack is a convenience; nothing is lost but it.
  }
  for (const listener of listeners) listener();
}

/** The window's closed tabs: the store behind All Tabs, ⌘⇧T and the Inbox's Open Session. */
export const closedTabs = {
  list: current,
  push: (entry: ClosedTab): void => {
    replace(pushClosed(current(), entry));
  },
  pop: (): ClosedTab | null => {
    const { entry, rest } = popClosed(current());
    if (entry !== null) replace(rest);
    return entry;
  },
  take: (id: string): ClosedTab | null => {
    const { entry, rest } = takeClosed(current(), id);
    if (entry !== null) replace(rest);
    return entry;
  },
  /** Forgets what was read: the next read goes to storage again. */
  reset: (): void => {
    held = null;
    for (const listener of listeners) listener();
  },
};

export function useClosedTabs(): readonly ClosedTab[] {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, current);
}
