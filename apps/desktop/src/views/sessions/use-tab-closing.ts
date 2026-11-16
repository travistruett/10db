import type { ChatId, ProjectId, TaskId } from '@10db/contracts';
import { useState } from 'react';
import { useArchiveChat, usePatchChat, useUnarchiveChat } from '../../daemon/chat-queries';
import { closedTabs, type ClosedTab } from './closed-tabs';
import { tabTitle, type StripTab } from './strip-tabs';
import { taskTabs } from './task-tabs';

export interface TabClosing {
  readonly tabs: readonly StripTab[];
  readonly selected: StripTab | null;
  /** The number of chats open, which bounds where a reopened tab can go. */
  readonly chatCount: number;
  readonly onSelect: (tab: StripTab) => void;
  /** A reopened chat is the one to show. */
  readonly onOpenChat: (chatId: ChatId, projectId: ProjectId) => void;
  readonly removeFresh: (id: string) => void;
  /** A reopened task's tab is the one to show. */
  readonly onOpenTask: (taskId: TaskId, projectId: ProjectId) => void;
}

/**
 * Closing, archiving and reopening (sessions UI spec §5.6). A close stops nothing on the daemon: the tab
 * leaves the strip and goes on the closed stack, and a warm chat stays warm.
 */
export function useTabClosing({
  tabs,
  selected,
  chatCount,
  onSelect,
  onOpenChat,
  removeFresh,
  onOpenTask,
}: TabClosing) {
  const patch = usePatchChat();
  const archive = useArchiveChat();
  const unarchive = useUnarchiveChat();
  const [notice, setNotice] = useState<string | null>(null);

  /** Focus moves to the tab on the right, or the left one when the closed tab was last. */
  const moveFrom = (tab: StripTab): void => {
    if (tab.key !== selected?.key) return;
    const index = tabs.indexOf(tab);
    const next = tabs[index + 1] ?? tabs[index - 1];
    if (next !== undefined) onSelect(next);
  };

  const remember = (tab: StripTab & { readonly kind: 'chat' }, archived: boolean): void => {
    closedTabs.push({
      chatId: tab.chat.id,
      projectId: tab.chat.projectId,
      title: tabTitle(tab),
      position: tab.chat.tabPosition ?? tab.position,
      ...(archived ? { archived: true } : {}),
    });
  };

  /** A task's tab leaves the strip and goes on the closed stack; the task itself is untouched. */
  const rememberTask = (tab: StripTab & { readonly kind: 'task' }): void => {
    taskTabs.close(tab.task.taskId);
    closedTabs.push({
      taskId: tab.task.taskId,
      projectId: tab.task.projectId,
      title: tab.task.title,
      place: tab.task.place,
      position: tab.task.position,
    });
  };

  const dropTab = (tab: StripTab): void => {
    switch (tab.kind) {
      case 'chat':
        remember(tab, false);
        patch.mutate({ chatId: tab.chat.id, tabPosition: null });
        return;
      case 'task':
        rememberTask(tab);
        return;
      case 'fresh':
        removeFresh(tab.tab.id);
        return;
    }
  };

  const close = (tab: StripTab): void => {
    setNotice(null);
    dropTab(tab);
    moveFrom(tab);
  };

  const closeOthers = (keep: StripTab): void => {
    setNotice(null);
    for (const tab of tabs) {
      if (tab.key === keep.key) continue;
      dropTab(tab);
    }
    if (selected?.key !== keep.key) onSelect(keep);
  };

  const archiveTab = (tab: StripTab): void => {
    if (tab.kind !== 'chat') return;
    setNotice(null);
    archive.mutate(tab.chat.id, {
      onSuccess: () => {
        remember(tab, true);
        moveFrom(tab);
      },
      onError: (error) => {
        setNotice(error.message);
      },
    });
  };

  /** Puts a closed tab back at the place it held, clamped to the strip; an archived one comes back first. */
  const reopen = async (entry: ClosedTab): Promise<void> => {
    setNotice(null);
    if ('taskId' in entry) {
      taskTabs.open({
        taskId: entry.taskId,
        projectId: entry.projectId,
        title: entry.title,
        place: entry.place,
        position: Math.min(entry.position, chatCount + taskTabs.list().length),
      });
      closedTabs.take(entry.taskId);
      onOpenTask(entry.taskId, entry.projectId);
      return;
    }
    try {
      if (entry.archived === true) await unarchive.mutateAsync(entry.chatId);
      const chat = await patch.mutateAsync({
        chatId: entry.chatId,
        tabPosition: Math.min(entry.position, chatCount),
      });
      closedTabs.take(entry.chatId);
      onOpenChat(chat.id, chat.projectId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  /** ⌘⇧T: the last closed tab; false when none is left. */
  const reopenLast = (): boolean => {
    const entry = closedTabs.list()[0];
    if (entry === undefined) return false;
    void reopen(entry);
    return true;
  };

  return { close, closeOthers, archiveTab, reopen, reopenLast, notice, setNotice };
}
