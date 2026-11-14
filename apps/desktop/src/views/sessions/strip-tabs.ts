import { CHAT_DEFAULT_TITLE, type ChatDto, type ProjectId } from '@10db/contracts';
import type { FreshTab } from './fresh-tabs';

/** One tab of the strip: a chat, or a fresh tab not yet made into one. */
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
    };

export function tabTitle(tab: StripTab): string {
  return tab.kind === 'chat' ? tab.chat.title : CHAT_DEFAULT_TITLE;
}

export function tabProjectId(tab: StripTab): ProjectId {
  return tab.kind === 'chat' ? tab.chat.projectId : tab.tab.projectId;
}
