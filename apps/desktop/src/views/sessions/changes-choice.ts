// Whether the builder opened or closed a session's Changes drawer, kept for the window: the screen
// unmounts a session when another is selected, and the choice holds for the session.

const chosen = new Map<string, boolean>();

export const changesChoice = {
  /** The builder's choice for the session, or null while they have made none. */
  get: (chatId: string): boolean | null => chosen.get(chatId) ?? null,
  set: (chatId: string, open: boolean): void => {
    chosen.set(chatId, open);
  },
  /** A session starts afresh. */
  forget: (chatId: string): void => {
    chosen.delete(chatId);
  },
};
