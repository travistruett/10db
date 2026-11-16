import type { InboxItemDto } from '@10db/contracts';
import dayjs from 'dayjs';
import type { ConversationId } from '@10db/contracts';
import { tabState, tabWords, type TabState, type TabWords } from './tab-state';
import { taskTabState } from './task-tab-state';
import type { StripTab } from './strip-tabs';

export interface TabInfo {
  readonly state: TabState;
  readonly words: TabWords;
}

/** What a tab shows, from its chat and the open cards that name its conversation. */
export function tabInfo(
  tab: StripTab,
  cards: ReadonlyMap<ConversationId, InboxItemDto[]>,
  seen: Readonly<Record<string, string>>,
): TabInfo {
  if (tab.kind === 'fresh') return { state: 'idle', words: tabWords('idle') };
  if (tab.kind === 'task') {
    const state = taskTabState(tab.facts);
    return { state, words: tabWords(state) };
  }
  const open = cards.get(tab.chat.conversationId) ?? [];
  const { conversation } = tab.chat;
  const state = tabState({
    state: conversation.state,
    openCards: open.length,
    lastReplyAt: tab.chat.lastReplyAt,
    seenAt: seen[tab.chat.id] ?? null,
  });
  const first = open[0];
  return {
    state,
    words: tabWords(state, {
      ...(first === undefined ? {} : { cardTitle: first.title }),
      ...(conversation.pausedUntil === null
        ? {}
        : { resumes: dayjs(conversation.pausedUntil).format('HH:mm') }),
    }),
  };
}

/** A tab's accessible name: "{title}, {project}, {state words}"; an idle tab has no state words. */
export function tabName(title: string, project: string, info: TabInfo): string {
  return [title, project, info.words.spoken].filter((part) => part !== '').join(', ');
}
