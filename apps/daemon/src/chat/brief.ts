import {
  CHAT_DEFAULT_TITLE,
  ConversationItemAuthor,
  ConversationItemKind,
  parseItemBody,
  TASK_MESSAGE_MAX_CHARS,
} from '@10db/contracts';
import type { ConversationItemRow } from '@10db/db';

// Sessions spec §7.3 (Do it): the brief the sheet starts from when the chat's agent has not written one. It is
// the chat so far plus the builder's last message, and never carries the request that asked for a brief.

/** The most characters of the conversation a fresh session or a brief is given, newest kept. */
export const DIGEST_MAX_CHARS = 12_000;

/** What the brief request asks of the agent. */
export function briefRequestText(draft: string | undefined): string {
  const base =
    'Write the brief for a task that does the work we agreed on, with its title, areas and acceptance criteria, and call write_brief. Change nothing.';
  return draft === undefined || draft.trim() === ''
    ? base
    : `${base} Include this request: ${draft.trim()}`;
}

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

/** The builder's last message that is not a brief request, or null. */
export function lastBuilderMessage(items: readonly ConversationItemRow[]): string | null {
  for (const item of [...items].reverse()) {
    if (item.kind !== ConversationItemKind.Message) continue;
    const body = parseItemBody(item.kind, item.body);
    if (body.purpose !== 'brief') return body.text;
  }
  return null;
}

/** The newest `max` characters of the chat's lines, cut at the front with an ellipsis. */
export function digestText(items: readonly ConversationItemRow[], max = DIGEST_MAX_CHARS): string {
  if (max <= 1) return '';
  const text = chatLines(items).join('\n\n');
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

const LAST = "The builder's last message: ";

/**
 * The brief made from the chat alone: its digest, then the builder's last message, the whole cut to
 * `TASK_MESSAGE_MAX_CHARS`. The last message is kept before the digest is, so a long one is never lost to it.
 */
export function briefFromChat(items: readonly ConversationItemRow[]): string {
  const last = lastBuilderMessage(items);
  const tail = last === null ? '' : `${LAST}${last}`.slice(0, TASK_MESSAGE_MAX_CHARS);
  const room = Math.max(0, TASK_MESSAGE_MAX_CHARS - tail.length - 2);
  const head = digestText(items, Math.min(DIGEST_MAX_CHARS, room));
  return [head, tail].filter((part) => part !== '').join('\n\n');
}

/** A task title for the brief: the chat's, unless it still has the default. */
export function briefTitle(chatTitle: string): string {
  return chatTitle === CHAT_DEFAULT_TITLE ? '' : chatTitle;
}
