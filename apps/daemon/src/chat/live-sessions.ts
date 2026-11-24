import type { ConversationId, SessionId } from '@10db/contracts';
import type { WaitObserver } from '../inbox';
import type { ToolImages } from '../mcp';
import type { ShapeReviewTurn } from '../shape';

// A chat's session that is open now, as its tools need it: a card a tool raises is told to the
// engine through the session's observer, so the tab says it waits, and goes when the session ends.

export interface ChatLive {
  readonly sessionId: SessionId;
  readonly observer: WaitObserver;
  /** Aborts when the session ends. */
  readonly signal: AbortSignal;
  /**
   * The planning rules a session that started with no plan is owed once it has one, while they are owed:
   * `peek` reads them, `take` reads them and owes them no longer. Null for a session that started with its
   * plan, which holds the rules in its system prompt (a resumed Codex thread's developer instructions).
   */
  readonly planRules: { peek(): string | null; take(): string | null } | null;
  /**
   * The reviews the session has been sent and is doing now, for a session that runs no subagents: it does Plan's
   * reviews itself, and only while one is live may its own `report_finding` pass. Always empty with subagents.
   */
  readonly review: () => readonly ShapeReviewTurn[];
  /** Whether this session runs no subagents, so does Plan's reviews itself. */
  readonly inSession: () => boolean;
  /**
   * Hands the session the pictures a tool answered, as a message into its open turn. Present only for an
   * agent that drops the image blocks of a tool result.
   */
  readonly showImages?: (images: ToolImages) => void;
}

export interface ChatLiveSessions {
  open(conversationId: ConversationId, live: ChatLive): void;
  /** Forgets the session, unless a later one of the conversation took its place. */
  end(conversationId: ConversationId, sessionId: SessionId): void;
  /** The conversation's open session, whoever it is. */
  current(conversationId: ConversationId): ChatLive | null;
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
    current: (conversationId) => open.get(conversationId) ?? null,
    get(conversationId, sessionId) {
      const live = open.get(conversationId);
      return live?.sessionId === sessionId ? live : null;
    },
  };
}
