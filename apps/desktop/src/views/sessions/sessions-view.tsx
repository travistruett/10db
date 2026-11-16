import {
  ConversationState,
  DoItPlace,
  type ChatDto,
  type DoItResult,
  type ProjectId,
  type TaskId,
  type TaskSessionDto,
} from '@10db/contracts';
import { Box, Button, Group, Modal, Paper, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useOpenChats, usePatchChat, useUnarchiveChat } from '../../daemon/chat-queries';
import { useInbox } from '../../daemon/queries';
import { Announcer } from '../../conversation/announcer';
import { HeaderSlot } from '../../shell/header-slot';
import { useSelectedProject } from '../../shell/selected-project';
import { ChatTab } from './chat-tab';
import { TaskTab as TaskTabView } from './task-tab';
import { taskTabKey, taskTabs, TaskTabPlace, useTaskTabs, type TaskTab } from './task-tabs';
import { useTaskSessions } from '../../daemon/task-session-queries';
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
import { useClosedTabs } from './closed-tabs';
import { useTabClosing } from './use-tab-closing';
import { openCardsByConversation } from './needs-you';
import { markSeen, readSeen } from './seen';
import { sessionAnnouncement } from './session-announcements';
import { nextNeeding, targetIndex } from './session-keys';
import { tabInfo } from './tab-info';
import { needsYou } from './tab-state';
import { useSessionKeys } from './use-session-keys';
import { panelId, TabStrip, type StripTab } from './tab-strip';
import { useTaskTabFacts } from './task-tab-facts';
import type { TaskTabFacts } from './task-tab-state';

export interface SessionsViewProps {
  readonly search: SessionsSearch;
  readonly onSearch: (search: SessionsSearch, replace: boolean) => void;
}

const NO_FACTS: TaskTabFacts = { board: null, failed: false, page: null, passClosed: false };

/** The strip's order: by place, a fresh tab before the chat that waits to move after it. */
function stripOf(
  chats: readonly ChatDto[],
  fresh: readonly FreshTabState[],
  tasks: readonly TaskTab[],
  sessions: ReadonlyMap<TaskId, TaskSessionDto>,
  facts: ReadonlyMap<TaskId, TaskTabFacts>,
): readonly StripTab[] {
  const tabs: StripTab[] = [
    ...tasks.map((task): StripTab => {
      const session = sessions.get(task.taskId);
      return {
        kind: 'task',
        key: taskTabKey(task.taskId),
        task: session === undefined ? task : { ...task, title: session.title },
        facts: facts.get(task.taskId) ?? NO_FACTS,
        position: task.position,
      };
    }),
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
  const taskList = useTaskTabs();
  const sessions = useTaskSessions(taskList.map((t) => t.taskId));
  const facts = useTaskTabFacts(sessions, inbox.data ?? []);
  const tabs = stripOf(chats, fresh, taskList, sessions, facts);
  const loaded = open.isSuccess && projects.isSuccess;

  // The screen is never blank: with nothing open, a fresh tab opens (UI spec §12, "No tabs").
  if (loaded && tabs.length === 0) {
    const made = openFreshTab(fresh, list, selectedProject?.id ?? null, -1);
    if (made !== null) setFresh(made.tabs);
  }

  const wanted =
    search.chat !== undefined
      ? draftKey.chat(search.chat)
      : search.task !== undefined
        ? taskTabKey(search.task)
        : search.fresh !== undefined
          ? draftKey.fresh(search.fresh)
          : null;
  const selected = tabs.find((t) => t.key === wanted) ?? tabs[0] ?? null;

  // A tab is seen while it is selected and the window has focus.
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

  const cards = openCardsByConversation(inbox.data ?? []);
  const infos = tabs.map((tab) => tabInfo(tab, cards, seen));

  const select_ = (tab: StripTab): void => {
    if (tab.kind === 'chat') {
      onSearch({ chat: tab.chat.id }, false);
      select(tab.chat.projectId);
    } else if (tab.kind === 'task') {
      onSearch({ task: tab.task.taskId }, false);
      select(tab.task.projectId);
    } else {
      onSearch({ fresh: tab.tab.id }, false);
      select(tab.tab.projectId);
    }
  };

  const closing = useTabClosing({
    tabs,
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
    onOpenTask: (taskId, projectId) => {
      onSearch({ task: taskId }, false);
      select(projectId);
    },
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [terminalFor, setTerminalFor] = useState<string | null>(null);
  // Archiving a chat in the builder's terminal asks first: it ends the takeover.
  const [endingTakeover, setEndingTakeover] = useState<StripTab | null>(null);
  const askArchive = (tab: StripTab): void => {
    if (tab.kind === 'chat' && tab.chat.conversation.state === ConversationState.TakenOver)
      setEndingTakeover(tab);
    else closing.archiveTab(tab);
  };
  const closed = useClosedTabs();

  const newTab = (): void => {
    const after = selected?.position ?? -1;
    const made = openFreshTab(fresh, list, selectedProject?.id ?? null, after);
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

  /** A recent session opens in this fresh tab's place. */
  const openRecent = async (tab: FreshTabState, chat: ChatDto): Promise<void> => {
    if (chat.archivedAt !== null) await unarchive.mutateAsync(chat.id);
    if (chat.tabPosition === null || chat.archivedAt !== null)
      await patch.mutateAsync({ chatId: chat.id, tabPosition: tab.position });
    dropFresh(tab.id);
    onSearch({ chat: chat.id }, true);
    select(chat.projectId);
  };

  /**
   * Do It was accepted: a separate copy's task takes the chat's place in the strip, and a pass of one opens
   * to the chat's right. A pass that waits for the folder has no task yet.
   */
  const handedOff = (chat: ChatDto, result: DoItResult, title: string): void => {
    if ('pending' in result) return;
    const here = result.place === DoItPlace.Here;
    taskTabs.open({
      taskId: result.taskId,
      projectId: chat.projectId,
      title,
      place: here ? TaskTabPlace.Pass : TaskTabPlace.Copy,
      position: (chat.tabPosition ?? 0) + (here ? 1 : 0),
    });
    onSearch({ task: result.taskId }, false);
  };

  const changeProject = (tab: FreshTabState, projectId: ProjectId): void => {
    setFresh((tabsNow) => setFreshProject(tabsNow, tab.id, projectId));
    select(projectId);
  };

  // Another tab that has just begun to need the builder is said once; the open tab says its own cards.
  const needingNow = tabs.flatMap((tab, i) =>
    needsYou(infos[i]?.state ?? 'idle') ? [tab.key] : [],
  );
  const needingBefore = useRef<ReadonlySet<string> | null>(null);
  const needingKey = needingNow.join('|');
  useEffect(() => {
    const before = needingBefore.current;
    needingBefore.current = new Set(needingNow);
    if (before === null) return;
    for (const tab of tabs) {
      if (tab.kind !== 'chat' || tab.key === selected?.key) continue;
      if (!needingNow.includes(tab.key) || before.has(tab.key)) continue;
      setAnnouncement(
        sessionAnnouncement({
          kind: 'needs_you',
          title: tab.chat.title,
          project: list.find((p) => p.id === tab.chat.projectId)?.name ?? '',
        }),
      );
    }
    // Read once per change in who needs the builder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needingKey]);

  useSessionKeys((key) => {
    const at = selected === null ? -1 : tabs.indexOf(selected);
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
          infos.map((info) => needsYou(info.state)),
          at,
        );
        const tab = next === null ? undefined : tabs[next];
        if (tab !== undefined) select_(tab);
        return true;
      }
      case 'go':
      case 'last':
      case 'prev':
      case 'next': {
        const index = targetIndex(key, at, tabs.length);
        const tab = index === null ? undefined : tabs[index];
        if (tab !== undefined) select_(tab);
        return true;
      }
      // The selected chat tab hears this one.
      case 'do_it':
      case 'changes':
      case 'stop':
        return false;
    }
  });

  return (
    <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Announcer message={announcement} label="Sessions announcements" />
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
              if (endingTakeover !== null) closing.archiveTab(endingTakeover);
              setEndingTakeover(null);
            }}
          >
            End Takeover and Archive
          </Button>
        </Group>
      </Modal>
      <HeaderSlot>
        <TabStrip
          tabs={tabs}
          selectedKey={selected?.key ?? null}
          projects={list}
          cards={cards}
          seen={seen}
          onSelect={select_}
          onClose={closing.close}
          closed={closed}
          onReopen={(entry) => {
            void closing.reopen(entry);
          }}
          onRename={(tab) => {
            select_(tab);
            if (tab.kind === 'chat') setRenaming(tab.chat.id);
          }}
          onArchive={askArchive}
          onOpenInTerminal={(tab) => {
            select_(tab);
            if (tab.kind === 'chat') setTerminalFor(tab.chat.id);
          }}
          onCloseOthers={closing.closeOthers}
          onNew={newTab}
          onReorder={(tab, position) => {
            if (tab.kind === 'chat') patch.mutate({ chatId: tab.chat.id, tabPosition: position });
          }}
        />
      </HeaderSlot>
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
        <div
          role="tabpanel"
          id={panelId(selected.key)}
          aria-labelledby={`session-tab-${selected.key}`}
          style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        >
          {selected.kind === 'fresh' ? (
            <FreshTab
              key={selected.tab.id}
              tab={selected.tab}
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
          ) : selected.kind === 'task' ? (
            <TaskTabView
              key={selected.task.taskId}
              tab={selected.task}
              project={list.find((p) => p.id === selected.task.projectId)}
            />
          ) : projects.isSuccess ? (
            <ChatTab
              key={selected.chat.id}
              chat={selected.chat}
              project={list.find((p) => p.id === selected.chat.projectId)}
              onAnnounce={setAnnouncement}
              onHandedOff={(result, title) => {
                handedOff(selected.chat, result, title);
              }}
              actions={{
                onArchive: () => {
                  askArchive(selected);
                },
                onClose: () => {
                  closing.close(selected);
                },
                onCloseOthers: () => {
                  closing.closeOthers(selected);
                },
                othersOpen: tabs.length > 1,
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
