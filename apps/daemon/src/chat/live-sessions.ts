import type { ConversationId, SessionId } from '@10db/contracts';
import type { WaitObserver } from '../inbox';

// A chat's session that is open now, as its tools need it: a card a tool raises is told to the
// engine through the session's observer, so the tab says it waits, and goes when the session ends.

export interface ChatLive {
  readonly sessionId: SessionId;
  readonly observer: WaitObserver;
  /** Aborts when the session ends. */
  readonly signal: AbortSignal;
  /**
   * The planning rules a session that started with no plan is owed, while they are owed: `peek` reads them,
   * `take` reads them and owes them no longer. Null for a session that started with its plan.
   */
  readonly planRules: { peek(): string | null; take(): string | null } | null;
}

export interface ChatLiveSessions {
  open(conversationId: ConversationId, live: ChatLive): void;
  /** Forgets the session, unless a later one of the conversation took its place. */
  end(conversationId: ConversationId, sessionId: SessionId): void;
  /** The conversation's open session, when it is this one. */
  get(conversationId: ConversationId, sessionId: SessionId): ChatLive | null;
}

export function createChatLiveSessions(): ChatLiveSessions {
  const open = new Map<ConversationId, ChatLive>();
  return {
    open(conversationId, live) {
      open.set(conversationId, live);
    },
    end(conversationId, sessionId) {
      if (open.get(conversationId)?.sessionId === sessionId) open.delete(conversationId);
    },
    get(conversationId, sessionId) {
      const live = open.get(conversationId);
      return live?.sessionId === sessionId ? live : null;
    },
  };
}
