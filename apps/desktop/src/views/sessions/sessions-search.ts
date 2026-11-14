import { ChatId } from '@10db/contracts';

/**
 * Sessions' address: `chat` selects an open session, `fresh` a tab not yet made into one. Each is kept
 * only when it parses.
 */
export interface SessionsSearch {
  readonly chat?: ChatId;
  readonly fresh?: string;
}

/** A fresh tab's id is a short random token. */
const FRESH_ID = /^[A-Za-z0-9_-]{1,40}$/;

export function sessionsSearch(search: Record<string, unknown>): SessionsSearch {
  const chat = ChatId.safeParse(search['chat']);
  const fresh = typeof search['fresh'] === 'string' && FRESH_ID.test(search['fresh']);
  return {
    ...(chat.success ? { chat: chat.data } : {}),
    ...(!chat.success && fresh ? { fresh: String(search['fresh']) } : {}),
  };
}
