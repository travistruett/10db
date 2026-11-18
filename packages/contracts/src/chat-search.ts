import { z } from 'zod';
import { ChatDto } from './chat';

/** Most characters of a panel search. */
export const CHAT_SEARCH_MAX = 200;

/** `GET /chats/search`: a title search across open, closed and archived sessions. */
export const ChatSearchQuery = z.strictObject({
  q: z.string().max(CHAT_SEARCH_MAX),
  after: z.string().min(1).optional(),
});
export type ChatSearchQuery = z.infer<typeof ChatSearchQuery>;

/** A page of matches; `next` is the cursor for the page after, or null on the last. */
export const ChatSearchPage = z.object({
  rows: z.array(ChatDto),
  next: z.string().nullable(),
});
export type ChatSearchPage = z.infer<typeof ChatSearchPage>;
