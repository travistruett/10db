import { CHAT_DEFAULT_TITLE, type ChatDto, type ProjectId } from '@10db/contracts';
import type { FreshTab } from './fresh-tabs';
import type { TaskTabFacts } from './task-tab-state';
import type { TaskTab } from './task-tabs';

/** One tab of the strip: a chat, a task Do It made, or a fresh tab not yet made into a chat. */
export type StripTab =
  | {
      readonly kind: 'chat';
      readonly key: string;
      readonly chat: ChatDto;
      readonly position: number;
    }
  | {
      readonly kind: 'fresh';
      readonly key: string;
      readonly tab: FreshTab;
      readonly position: number;
    }
  | {
      readonly kind: 'task';
      readonly key: string;
      readonly task: TaskTab;
      /** What the strip has read of the task, for its mark. */
      readonly facts: TaskTabFacts;
      readonly position: number;
    };

export function tabTitle(tab: StripTab): string {
  switch (tab.kind) {
    case 'chat':
      return tab.chat.title;
    case 'task':
      return tab.task.title;
    case 'fresh':
      return CHAT_DEFAULT_TITLE;
  }
}

export function tabProjectId(tab: StripTab): ProjectId {
  switch (tab.kind) {
    case 'chat':
      return tab.chat.projectId;
    case 'task':
      return tab.task.projectId;
    case 'fresh':
      return tab.tab.projectId;
  }
}
