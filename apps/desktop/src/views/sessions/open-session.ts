import type { ChatId, ProjectId, TaskId } from '@10db/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useOpenChats, usePatchChat } from '../../daemon/chat-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { closedTabs } from './closed-tabs';
import { taskTabs, type TaskTabPlace } from './task-tabs';

/**
 * Opens a session's tab from anywhere (the Inbox's Open Session, a notification's click): it selects the
 * tab and its project. A tab that is closed comes back where it was (`closedTabs`), or at the end of
 * the strip when the stack no longer holds it. Sessions' composer takes the cursor once the tab shows.
 */
export function useOpenSession(): (chatId: ChatId, projectId: ProjectId) => Promise<void> {
  const open = useOpenChats().data;
  const patch = usePatchChat();
  const navigate = useNavigate();
  const { select } = useSelectedProject();
  return async (chatId, projectId) => {
    const count = open?.length ?? 0;
    if (open?.some((chat) => chat.id === chatId) !== true) {
      const entry = closedTabs.take(chatId);
      await patch.mutateAsync({ chatId, tabPosition: Math.min(entry?.position ?? count, count) });
    }
    select(projectId);
    await navigate({ to: '/sessions', search: { chat: chatId } });
  };
}

/** What opening a task's tab needs to put it in the strip. */
export interface TaskToOpen {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly place: TaskTabPlace;
}

/**
 * Opens a task's tab from anywhere (the chat's row, the Inbox, the Board's drawer): the tab is put in the strip
 * where it was closed, or at its end, and selected.
 */
export function useOpenTask(): (task: TaskToOpen) => Promise<void> {
  const open = useOpenChats().data;
  const navigate = useNavigate();
  const { select } = useSelectedProject();
  return async (task) => {
    if (!taskTabs.list().some((t) => t.taskId === task.taskId)) {
      const entry = closedTabs.take(task.taskId);
      const end = (open?.length ?? 0) + taskTabs.list().length;
      taskTabs.open({ ...task, position: Math.min(entry?.position ?? end, end) });
    }
    select(task.projectId);
    await navigate({ to: '/sessions', search: { task: task.taskId } });
  };
}
