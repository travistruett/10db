import { ConversationItemAuthor, ConversationItemKind, parseItemBody } from '@10db/contracts';
import type { ConversationItemRow } from '@10db/db';

// Sessions spec §7.3 (Do it): the chat so far, read back for a fresh session; it never carries a request that
// asked for a brief.

/** The most characters of the conversation a fresh session or a brief is given, newest kept. */
export const DIGEST_MAX_CHARS = 12_000;

/**
 * The chat's lines, `Builder:` and `You:`, left out of every brief request and the agent's items of the turn
 * it began, so no earlier request (cancelled, expired or before a restart) leaks "Change nothing" anywhere.
 */
export function chatLines(items: readonly ConversationItemRow[]): string[] {
  const lines: string[] = [];
  let inBriefTurn = false;
  for (const item of items) {
    if (item.kind === ConversationItemKind.Message) {
      const body = parseItemBody(item.kind, item.body);
      // A carry-on is 10db's line to the session, not something the builder said.
      if (body.purpose === 'carry_on') continue;
      inBriefTurn = body.purpose === 'brief';
      if (!inBriefTurn) lines.push(`Builder: ${body.text}`);
    } else if (
      item.kind === ConversationItemKind.AgentMessage &&
      item.author === ConversationItemAuthor.Agent &&
      !item.partial &&
      !inBriefTurn
    )
      lines.push(`You: ${parseItemBody(item.kind, item.body).text}`);
  }
  return lines;
}

/** The newest `max` characters of the chat's lines, cut at the front with an ellipsis. */
export function digestText(items: readonly ConversationItemRow[], max = DIGEST_MAX_CHARS): string {
  if (max <= 1) return '';
  const text = chatLines(items).join('\n\n');
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}
