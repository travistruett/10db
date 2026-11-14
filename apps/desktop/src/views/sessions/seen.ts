import { z } from 'zod';

// When the builder last looked at each tab, per window (`localStorage`): a reply after it is a new reply.

const KEY = 'tendb.sessions.seen';

const Seen = z.record(z.string(), z.string());

/** Chat id to the time it was last seen; a store that does not parse reads as nothing seen. */
export function readSeen(): Readonly<Record<string, string>> {
  try {
    const parsed = Seen.safeParse(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function markSeen(chatId: string, at: string): Readonly<Record<string, string>> {
  const next = { ...readSeen(), [chatId]: at };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
