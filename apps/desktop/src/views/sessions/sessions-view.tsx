import type { ChatDto, ProjectId } from '@10db/contracts';
import { Box } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useOpenChats, usePatchChat, useUnarchiveChat } from '../../daemon/chat-queries';
import { Announcer } from '../../conversation/announcer';
import { HeaderSlot } from '../../shell/header-slot';
import { useSelectedProject } from '../../shell/selected-project';
import { ChatTab } from './chat-tab';
import { FreshTab } from './fresh-tab';
import {
  openFreshTab,
  readFreshTabs,
  removeFreshTab,
  setFreshModel,
  setFreshProject,
  writeFreshTabs,
  type FreshTab as FreshTabState,
} from './fresh-tabs';
import { draftKey, sessionDrafts } from './session-drafts';
import type { SessionsSearch } from './sessions-search';
import { TabStrip, type StripTab } from './tab-strip';

export interface SessionsViewProps {
  readonly search: SessionsSearch;
  readonly onSearch: (search: SessionsSearch, replace: boolean) => void;
}

/** The strip's order: by place, a fresh tab before the chat that waits to move after it. */
function stripOf(chats: readonly ChatDto[], fresh: readonly FreshTabState[]): readonly StripTab[] {
  const tabs: StripTab[] = [
    ...chats.map((chat): StripTab => ({
      kind: 'chat',
      key: draftKey.chat(chat.id),
      chat,
      position: chat.tabPosition ?? 0,
    })),
    ...fresh.map((tab): StripTab => ({
      kind: 'fresh',
      key: draftKey.fresh(tab.id),
      tab,
      position: tab.position,
    })),
  ];
  return tabs.sort(
    (a, b) =>
      a.position - b.position || (a.kind === 'fresh' ? -1 : 1) - (b.kind === 'fresh' ? -1 : 1),
  );
}

/**
 * Sessions (UI spec §4): the strip in the header's slot, and the selected tab beneath it. With no tab
 * open it opens a fresh one, so the screen is never blank.
 */
export function SessionsView({ search, onSearch }: SessionsViewProps) {
  const { projects, project: selectedProject, select } = useSelectedProject();
  const open = useOpenChats();
  const patch = usePatchChat();
  const unarchive = useUnarchiveChat();
  const [fresh, setFresh] = useState<readonly FreshTabState[]>(readFreshTabs);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  useEffect(() => {
    writeFreshTabs(fresh);
  }, [fresh]);

  const list = projects.data ?? [];
  const chats = open.data ?? [];
  const tabs = stripOf(chats, fresh);
  const loaded = open.isSuccess && projects.isSuccess;

  // The screen is never blank: with nothing open, a fresh tab opens (UI spec §12, "No tabs").
  if (loaded && tabs.length === 0) {
    const made = openFreshTab(fresh, list, selectedProject?.id ?? null, -1);
    if (made !== null) setFresh(made.tabs);
  }

  const wanted =
    search.chat !== undefined
      ? draftKey.chat(search.chat)
      : search.fresh !== undefined
        ? draftKey.fresh(search.fresh)
        : null;
  const selected = tabs.find((t) => t.key === wanted) ?? tabs[0] ?? null;

  const select_ = (tab: StripTab): void => {
    if (tab.kind === 'chat') {
      onSearch({ chat: tab.chat.id }, false);
      select(tab.chat.projectId);
    } else {
      onSearch({ fresh: tab.tab.id }, false);
      select(tab.tab.projectId);
    }
  };

  const newTab = (): void => {
    const after = selected?.position ?? -1;
    const made = openFreshTab(fresh, list, selectedProject?.id ?? null, after);
    if (made === null) return;
    setFresh(made.tabs);
    onSearch({ fresh: made.opened.id }, false);
  };

  /** The chat takes the fresh tab's place; its draft, and a send asked for, go with it. */
  const chatMade = (tab: FreshTabState, chat: ChatDto, send: boolean): void => {
    sessionDrafts.move(draftKey.fresh(tab.id), draftKey.chat(chat.id));
    if (send) sessionDrafts.requestSend(draftKey.chat(chat.id));
    setFresh((tabsNow) => removeFreshTab(tabsNow, tab.id));
    onSearch({ chat: chat.id }, true);
  };

  /** A recent session opens in this fresh tab's place. */
  const openRecent = async (tab: FreshTabState, chat: ChatDto): Promise<void> => {
    if (chat.archivedAt !== null) await unarchive.mutateAsync(chat.id);
    if (chat.tabPosition === null || chat.archivedAt !== null)
      await patch.mutateAsync({ chatId: chat.id, tabPosition: tab.position });
    setFresh((tabsNow) => removeFreshTab(tabsNow, tab.id));
    onSearch({ chat: chat.id }, true);
    select(chat.projectId);
  };

  const changeProject = (tab: FreshTabState, projectId: ProjectId): void => {
    setFresh((tabsNow) => setFreshProject(tabsNow, tab.id, projectId));
    select(projectId);
  };

  return (
    <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Announcer message={announcement} label="Sessions announcements" />
      <HeaderSlot>
        <TabStrip
          tabs={tabs}
          selectedKey={selected?.key ?? null}
          projects={list}
          onSelect={select_}
          onNew={newTab}
        />
      </HeaderSlot>
      {selected?.kind === 'fresh' ? (
        <FreshTab
          key={selected.tab.id}
          tab={selected.tab}
          projects={list}
          onProject={(projectId) => {
            changeProject(selected.tab, projectId);
          }}
          onModel={(model) => {
            setFresh((tabsNow) => setFreshModel(tabsNow, selected.tab.id, model));
          }}
          onChatMade={(chat, send) => {
            chatMade(selected.tab, chat, send);
          }}
          onOpenRecent={(chat) => {
            void openRecent(selected.tab, chat);
          }}
        />
      ) : selected?.kind === 'chat' && projects.isSuccess ? (
        <ChatTab
          key={selected.chat.id}
          chat={selected.chat}
          project={list.find((p) => p.id === selected.chat.projectId)}
          onAnnounce={setAnnouncement}
        />
      ) : null}
    </Box>
  );
}
