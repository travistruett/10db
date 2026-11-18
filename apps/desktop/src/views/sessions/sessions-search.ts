import { ChatId, TaskId } from '@10db/contracts';

/**
 * Sessions' address: `chat` selects an open session, `fresh` a tab not yet made into one, and `task` is only read so a link to a
 * task's old tab can be redirected. Each is kept
 * only when it parses.
 */
export interface SessionsSearch {
  readonly chat?: ChatId;
  /** A task's old tab: the route sends it to the Board. */
  readonly task?: TaskId;
  readonly fresh?: string;
}

/** A fresh tab's id is a short random token. */
const FRESH_ID = /^[A-Za-z0-9_-]{1,40}$/;

export function sessionsSearch(search: Record<string, unknown>): SessionsSearch {
  const chat = ChatId.safeParse(search['chat']);
  const task = TaskId.safeParse(search['task']);
  const fresh = typeof search['fresh'] === 'string' && FRESH_ID.test(search['fresh']);
  return {
    ...(chat.success ? { chat: chat.data } : {}),
    ...(!chat.success && task.success ? { task: task.data } : {}),
    ...(!chat.success && !task.success && fresh ? { fresh: String(search['fresh']) } : {}),
  };
}
