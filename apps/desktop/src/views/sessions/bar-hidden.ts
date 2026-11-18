// Which question of the work bar the builder hid with Esc, for each session, kept for the window: the screen
// unmounts a session when another is selected, and a hidden bar stays hidden when it is shown again.

const hidden = new Map<string, string | null>();

export const barHidden = {
  /** The `askedAt` of the question hidden in the session; undefined while none is. */
  get: (chatId: string): string | null | undefined => hidden.get(chatId),
  set: (chatId: string, askedAt: string | null): void => {
    hidden.set(chatId, askedAt);
  },
  /** A session starts afresh. */
  forget: (chatId: string): void => {
    hidden.delete(chatId);
  },
};
