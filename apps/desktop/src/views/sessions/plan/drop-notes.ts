import type { ChatId } from '@10db/contracts';

// Why files dropped into a New Plan tab were refused, kept for the session that tab becomes: the tab
// is replaced as soon as its session exists, and the reasons arrive before it goes.

const waiting = new Map<ChatId, readonly string[]>();

export const dropNotes = {
  leave: (chatId: ChatId, reasons: readonly string[]): void => {
    if (reasons.length > 0) waiting.set(chatId, reasons);
  },
  /** What was left for the session, once. */
  take: (chatId: ChatId): readonly string[] => {
    const reasons = waiting.get(chatId) ?? [];
    waiting.delete(chatId);
    return reasons;
  },
};
