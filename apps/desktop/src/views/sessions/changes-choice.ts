// Whether the builder opened or closed a task tab's Changes panel, kept for the window: the strip
// unmounts a tab when another is selected, and the choice holds for the tab (sessions UI §9).

const chosen = new Map<string, boolean>();

export const changesChoice = {
  /** The builder's choice for the task's tab, or null while they have made none. */
  get: (taskId: string): boolean | null => chosen.get(taskId) ?? null,
  set: (taskId: string, open: boolean): void => {
    chosen.set(taskId, open);
  },
  /** A closed tab starts afresh when it opens again. */
  forget: (taskId: string): void => {
    chosen.delete(taskId);
  },
};
