import type { ChatDto, ConversationId, InboxItemDto } from '@10db/contracts';
import { WorkPlace } from '@10db/contracts';
import dayjs from 'dayjs';
import { TabState, tabState, tabWords, type TabWords } from './tab-state';

export interface TabInfo {
  readonly state: TabState;
  readonly words: TabWords;
  /** What the words need: the title of the card the session waits on, and when a pause ends. */
  readonly detail: { readonly cardTitle?: string; readonly resumes?: string };
}

/**
 * What a session shows, from its chat and the open cards that name its conversation. A session that has
 * not been told where to work waits on the builder even before its card is read.
 */
export function chatInfo(
  chat: ChatDto,
  cards: ReadonlyMap<ConversationId, InboxItemDto[]>,
  seen: Readonly<Record<string, string>>,
): TabInfo {
  const open = cards.get(chat.conversationId) ?? [];
  const { conversation } = chat;
  const read = tabState({
    state: conversation.state,
    openCards: open.length,
    lastReplyAt: chat.lastReplyAt,
    seenAt: seen[chat.id] ?? null,
  });
  const state =
    chat.work?.place === WorkPlace.Choosing && read !== TabState.Error ? TabState.NeedsYou : read;
  const first = open[0];
  const detail = {
    ...(first === undefined ? {} : { cardTitle: first.title }),
    ...(conversation.pausedUntil === null
      ? {}
      : { resumes: dayjs(conversation.pausedUntil).format('HH:mm') }),
  };
  return { state, words: tabWords(state, detail), detail };
}

/** A session's accessible name: "{title}, {project}, {state words}"; an idle one has no state words. */
export function sessionName(title: string, project: string, spoken: string): string {
  return [title, project, spoken].filter((part) => part !== '').join(', ');
}
