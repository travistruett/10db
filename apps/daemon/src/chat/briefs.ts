import type { ChatId, SessionId, WriteBriefInput } from '@10db/contracts';
import type { Clock } from '../clock';

// Sessions spec §7.3 (Do it): the briefs the chats' agents wrote and the requests for them still open. Both
// live in memory: a restart drops them, and the sheet then reads the chat so far.

/** How long the sheet waits for the agent's brief before it takes the chat read back. */
export const BRIEF_WAIT_MS = 60_000;
/** How long a written brief is kept for the sheet. */
export const BRIEF_KEEP_MS = 30 * 60_000;

/** A brief the agent wrote, with the session that wrote it. */
export interface WrittenBrief extends WriteBriefInput {
  readonly sessionId: SessionId;
  readonly writtenAt: number;
}

export interface Briefs {
  /** Keeps the agent's brief for the chat. */
  write(chatId: ChatId, brief: WriteBriefInput, sessionId: SessionId): void;
  /** The chat's written brief, or null once it is older than the keep time. */
  written(chatId: ChatId): WrittenBrief | null;
  /** Notes that the agent was asked for a brief now; a new request replaces an older one. */
  ask(chatId: ChatId): void;
  /** When the agent was last asked and has not yet written, or null. */
  asked(chatId: ChatId): number | null;
  /** Whether the request for a brief has waited longer than the agent is given. */
  expired(chatId: ChatId): boolean;
  /** Forgets the request for a brief: the agent wrote, the builder cancelled, or a send replaced it. */
  endAsk(chatId: ChatId): void;
  /** Forgets everything for the chat: Do It succeeded. */
  forget(chatId: ChatId): void;
}

export function createBriefs(clock: Pick<Clock, 'now'>): Briefs {
  const written = new Map<ChatId, WrittenBrief>();
  const asked = new Map<ChatId, number>();
  const nowMs = (): number => clock.now().getTime();
  return {
    write(chatId, brief, sessionId) {
      written.set(chatId, { ...brief, sessionId, writtenAt: nowMs() });
      asked.delete(chatId);
    },
    written(chatId) {
      const brief = written.get(chatId);
      if (brief === undefined) return null;
      if (nowMs() - brief.writtenAt > BRIEF_KEEP_MS) {
        written.delete(chatId);
        return null;
      }
      return brief;
    },
    ask(chatId) {
      asked.set(chatId, nowMs());
      written.delete(chatId);
    },
    asked: (chatId) => asked.get(chatId) ?? null,
    expired(chatId) {
      const at = asked.get(chatId);
      return at !== undefined && nowMs() - at >= BRIEF_WAIT_MS;
    },
    endAsk(chatId) {
      asked.delete(chatId);
    },
    forget(chatId) {
      written.delete(chatId);
      asked.delete(chatId);
    },
  };
}
