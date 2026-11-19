import { ConversationState, type ChatDto, type ProjectId } from '@10db/contracts';
import { useNavigate } from '@tanstack/react-router';
import { Box, Button, Group, Modal, Paper, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { ArchiveConfirm } from './archive-confirm';
import { useOpenChats, usePatchChat, useUnarchiveChat } from '../../daemon/chat-queries';
import { useChatWork } from '../../daemon/chat-work-queries';
import { useInbox } from '../../daemon/queries';
import { Announcer } from '../../conversation/announcer';
import { TitleRow } from '../../shell/title-row';
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
import { draftKey, sessionDrafts, type SendRequest } from './session-drafts';
import type { SessionsSearch } from './sessions-search';
import { closedTabs, useClosedTabs } from './closed-tabs';
import { useSessionClosing } from './use-session-closing';
import { openCardsByConversation } from './needs-you';
import { panelGroups, panelOrder, topPosition, type PanelRow } from './panel-order';
import { rowState, type RowState } from './row-state';
import { markSeen, readSeen } from './seen';
import { sessionAnnouncement } from './session-announcements';
import { SessionSwitcher } from './session-switcher';
import { SessionsPanel } from './sessions-panel';
import { nextNeeding, targetIndex } from './session-keys';
import { chatInfo } from './tab-info';
import { needsYou } from './tab-state';
import { useSessionKeys } from './use-session-keys';

export interface SessionsViewProps {
  readonly search: SessionsSearch;
  readonly onSearch: (search: SessionsSearch, replace: boolean) => void;
}

/**
 * Sessions (sessions spec §6): the panel of sessions by project, and the selected session or fresh tab in
 * the content. With nothing open it opens a fresh tab, so the screen is never blank.
 */
export function SessionsView({ search, onSearch }: SessionsViewProps) {
  const { projects, project: selectedProject, select } = useSelectedProject();
  const open = useOpenChats();
  const patch = usePatchChat();
  const unarchive = useUnarchiveChat();
  const navigate = useNavigate();
  const [fresh, setFresh] = useState<readonly FreshTabState[]>(readFreshTabs);
  // The fresh tabs this screen has let go, which the storage still holds until its next write.
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const dropFresh = (id: string): void => {
    setDropped((held) => new Set(held).add(id));
    setFresh((tabsNow) => removeFreshTab(tabsNow, id));
  };
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [seen, setSeen] = useState(readSeen);
  const inbox = useInbox();
  useEffect(() => {
    writeFreshTabs(fresh);
  }, [fresh]);

  // ⌘T on another view writes a fresh tab and lands here on it; a tab this screen does not know yet is read in.
  if (
    search.fresh !== undefined &&
    !dropped.has(search.fresh) &&
    !fresh.some((t) => t.id === search.fresh)
  ) {
    const stored = readFreshTabs();
    if (stored.some((t) => t.id === search.fresh)) setFresh(stored);
  }

  const list = projects.data ?? [];
  const chats = open.data ?? [];
  const groups = panelGroups(list, chats, fresh);
  const rows = panelOrder(groups);
  const loaded = open.isSuccess && projects.isSuccess;

  // The screen is never blank: with nothing open, a fresh tab opens.
  if (loaded && rows.length === 0) {
    const made = openFreshTab(fresh, list, selectedProject?.id ?? null, -1);
    if (made !== null) setFresh(made.tabs);
  }

  const wanted =
    search.chat !== undefined
      ? draftKey.chat(search.chat)
      : search.fresh !== undefined
        ? draftKey.fresh(search.fresh)
        : null;
  const selected = rows.find((r) => r.key === wanted) ?? rows[0] ?? null;

  // A session is seen while it is selected and the window has focus.
  const selectedChat = selected?.kind === 'chat' ? selected.chat : null;
  const lastReplyAt = selectedChat?.lastReplyAt ?? null;
  useEffect(() => {
    if (selectedChat === null || lastReplyAt === null) return;
    const look = (): void => {
      if (document.hasFocus()) setSeen(markSeen(selectedChat.id, new Date().toISOString()));
    };
    look();
    window.addEventListener('focus', look);
    return () => {
      window.removeEventListener('focus', look);
    };
  }, [selectedChat, lastReplyAt]);

  // The pull request's state is read for the session on screen alone; the others' marks leave it out.
  const work = useChatWork(selectedChat?.id ?? null).data;
  const pullRequest = work?.pullRequest ?? null;
  const cards = openCardsByConversation(inbox.data ?? []);
  const infos = new Map(
    rows.flatMap((row) =>
      row.kind === 'chat' ? [[row.key, chatInfo(row.chat, cards, seen)]] : [],
    ),
  );
  const states = new Map<string, RowState>(
    rows.flatMap((row) => {
      const info = infos.get(row.key);
      if (row.kind !== 'chat' || info === undefined) return [];
      const mine = row.chat.id === selectedChat?.id ? pullRequest : null;
      return [
        [
          row.key,
          rowState(
            {
              tab: info.state,
              place: row.chat.work?.place ?? null,
              pullRequest: mine === null ? null : mine.merged ? 'merged' : 'open',
            },
            info.detail,
          ),
        ],
      ];
    }),
  );

  const select_ = (row: PanelRow): void => {
    if (row.kind === 'chat') {
      onSearch({ chat: row.chat.id }, false);
      select(row.chat.projectId);
    } else {
      onSearch({ fresh: row.tab.id }, false);
      select(row.tab.projectId);
    }
  };

  const closing = useSessionClosing({
    rows,
    selected,
    chatCount: chats.length,
    onSelect: select_,
    onOpenChat: (chatId, projectId) => {
      onSearch({ chat: chatId }, false);
      select(projectId);
    },
    removeFresh: (id) => {
      dropFresh(id);
    },
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [terminalFor, setTerminalFor] = useState<string | null>(null);
  // Archiving a session in the builder's terminal asks first: it ends the takeover.
  const [endingTakeover, setEndingTakeover] = useState<PanelRow | null>(null);
  const askArchive = (row: PanelRow): void => {
    if (row.kind === 'chat' && row.chat.conversation.state === ConversationState.TakenOver)
      setEndingTakeover(row);
    else closing.archiveRow(row);
  };
  const closed = useClosedTabs();

  const newTab = (): void => {
    const made = openFreshTab(fresh, list, selectedProject?.id ?? null, -1);
    if (made === null) return;
    setFresh(made.tabs);
    onSearch({ fresh: made.opened.id }, false);
  };

  /** The chat takes the fresh tab's place; its draft, and a send asked for, go with it. */
  const chatMade = (tab: FreshTabState, chat: ChatDto, send: SendRequest | null): void => {
    sessionDrafts.move(draftKey.fresh(tab.id), draftKey.chat(chat.id));
    if (send !== null) sessionDrafts.requestSend(draftKey.chat(chat.id), send);
    dropFresh(tab.id);
    onSearch({ chat: chat.id }, true);
  };

  /** A session that is not open comes back, at the top of its project, and opens. */
  const bringBack = async (chat: ChatDto): Promise<void> => {
    if (chat.archivedAt !== null) await unarchive.mutateAsync(chat.id);
    if (chat.tabPosition === null || chat.archivedAt !== null)
      await patch.mutateAsync({ chatId: chat.id, tabPosition: topPosition(chats, chat.projectId) });
    // It is open again, so Recently closed no longer lists it.
    closedTabs.take(chat.id);
  };

  /** A recent session opens in this fresh tab's place. */
  const openRecent = async (tab: FreshTabState, chat: ChatDto): Promise<void> => {
    await bringBack(chat);
    dropFresh(tab.id);
    onSearch({ chat: chat.id }, true);
    select(chat.projectId);
  };

  /** A session the panel's search found opens where it is, whether it was open, closed or archived. */
  const openFound = async (chat: ChatDto): Promise<void> => {
    await bringBack(chat);
    onSearch({ chat: chat.id }, false);
    select(chat.projectId);
  };

  const changeProject = (tab: FreshTabState, projectId: ProjectId): void => {
    setFresh((tabsNow) => setFreshProject(tabsNow, tab.id, projectId));
    select(projectId);
  };

  const makeTask = (row: PanelRow): void => {
    if (row.kind !== 'chat') return;
    // The Board files in the selected project, which a right-click on another project's row left alone.
    select(row.chat.projectId);
    void navigate({ to: '/board', search: { newTask: row.chat.title } });
  };

  // Another session that has just begun to need the builder is said once; the open one says its own cards.
  const needingNow = rows.flatMap((row) =>
    needsYou(infos.get(row.key)?.state ?? 'idle') ? [row.key] : [],
  );
  const needingBefore = useRef<ReadonlySet<string> | null>(null);
  const needingKey = needingNow.join('|');
  useEffect(() => {
    const before = needingBefore.current;
    needingBefore.current = new Set(needingNow);
    if (before === null) return;
    for (const row of rows) {
      if (row.kind !== 'chat' || row.key === selected?.key) continue;
      if (!needingNow.includes(row.key) || before.has(row.key)) continue;
      setAnnouncement(
        sessionAnnouncement({
          kind: 'needs_you',
          title: row.chat.title,
          project: list.find((p) => p.id === row.chat.projectId)?.name ?? '',
        }),
      );
    }
    // Read once per change in who needs the builder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needingKey]);

  useSessionKeys((key) => {
    const at = selected === null ? -1 : rows.findIndex((r) => r.key === selected.key);
    switch (key.kind) {
      case 'new':
        newTab();
        return true;
      case 'close':
        if (selected === null) return false;
        closing.close(selected);
        return true;
      case 'reopen':
        return closing.reopenLast();
      case 'next_needing': {
        const next = nextNeeding(
          rows.map((row) => needsYou(infos.get(row.key)?.state ?? 'idle')),
          at,
        );
        const row = next === null ? undefined : rows[next];
        if (row !== undefined) select_(row);
        return true;
      }
      case 'go':
      case 'last':
      case 'prev':
      case 'next': {
        const index = targetIndex(key, at, rows.length);
        const row = index === null ? undefined : rows[index];
        if (row !== undefined) select_(row);
        return true;
      }
      // The selected session hears these.
      case 'changes':
      case 'stop':
        return false;
    }
  });

  const switcher = (
    <SessionSwitcher
      groups={groups}
      projects={list}
      closed={closed}
      selectedKey={selected?.key ?? null}
      onSelect={select_}
      onReopen={(entry) => {
        void closing.reopen(entry);
      }}
      onNew={newTab}
    />
  );

  return (
    <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Announcer message={announcement} label="Sessions announcements" />
      <SessionsPanel
        groups={groups}
        projects={list}
        selectedKey={selected?.key ?? null}
        states={states}
        closed={closed}
        onSelect={select_}
        onClose={closing.close}
        onNew={newTab}
        onRename={(row) => {
          select_(row);
          if (row.kind === 'chat') setRenaming(row.chat.id);
        }}
        onArchive={askArchive}
        onOpenInTerminal={(row) => {
          select_(row);
          if (row.kind === 'chat') setTerminalFor(row.chat.id);
        }}
        onMakeTask={makeTask}
        onReorder={(chat, position) => {
          patch.mutate({ chatId: chat.id, tabPosition: position });
        }}
        onReopen={(entry) => {
          void closing.reopen(entry);
        }}
        onOpenFound={(chat) => {
          void openFound(chat);
        }}
      />
      <Modal
        opened={endingTakeover !== null}
        onClose={() => {
          setEndingTakeover(null);
        }}
        title="End takeover and archive?"
        centered
      >
        <Text size="sm">
          This chat is in your terminal. Archiving ends the takeover and closes the chat. What you
          did in the terminal stays in the agent&apos;s own session.
        </Text>
        <Group justify="flex-end" gap="xs" mt="md">
          <Button
            variant="subtle"
            onClick={() => {
              setEndingTakeover(null);
            }}
          >
            Cancel
          </Button>
          <Button
            data-autofocus
            onClick={() => {
              if (endingTakeover !== null) closing.archiveRow(endingTakeover);
              setEndingTakeover(null);
            }}
          >
            End Takeover and Archive
          </Button>
        </Group>
      </Modal>
      <ArchiveConfirm
        preview={closing.confirming?.preview ?? null}
        pending={closing.archiving}
        onCancel={closing.cancelArchive}
        onConfirm={(preview) => {
          if (closing.confirming === null) return;
          closing.archiveRow(closing.confirming.row, {
            uncommitted: preview.uncommitted,
            ignored: preview.ignored,
          });
        }}
      />
      {selected?.kind === 'fresh' ? <TitleRow title="New Session" switcher={switcher} /> : null}
      {closing.notice === null ? null : (
        <Paper role="status" withBorder px="sm" py={6} mx="md" mt="xs">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">{closing.notice}</Text>
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => {
                closing.setNotice(null);
              }}
            >
              Dismiss
            </Button>
          </Group>
        </Paper>
      )}
      {selected === null ? null : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {selected.kind === 'fresh' ? (
            <FreshTab
              key={selected.tab.id}
              tab={selected.tab}
              tabPosition={topPosition(chats, selected.tab.projectId)}
              projects={list}
              onProject={(projectId) => {
                changeProject(selected.tab, projectId);
              }}
              onModel={(model, effort) => {
                setFresh((tabsNow) => setFreshModel(tabsNow, selected.tab.id, model, effort));
              }}
              onChatMade={(chat, send) => {
                chatMade(selected.tab, chat, send);
              }}
              onOpenRecent={(chat) => {
                void openRecent(selected.tab, chat);
              }}
            />
          ) : projects.isSuccess ? (
            <ChatTab
              key={selected.chat.id}
              chat={selected.chat}
              project={list.find((p) => p.id === selected.chat.projectId)}
              onAnnounce={setAnnouncement}
              switcher={switcher}
              actions={{
                onArchive: () => {
                  askArchive(selected);
                },
                onClose: () => {
                  closing.close(selected);
                },
                onMakeTask: () => {
                  makeTask(selected);
                },
              }}
              openingTerminal={terminalFor === selected.chat.id}
              onTerminalAsked={() => {
                setTerminalFor(null);
              }}
              renaming={renaming === selected.chat.id}
              onRenamed={() => {
                setRenaming(null);
              }}
            />
          ) : null}
        </div>
      )}
    </Box>
  );
}
