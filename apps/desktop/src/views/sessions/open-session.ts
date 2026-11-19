import type { ChatId, ProjectId, TaskId } from '@10db/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useOpenChats, usePatchChat } from '../../daemon/chat-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { closedTabs } from './closed-tabs';

/**
 * Opens a session's tab from anywhere (the Inbox's Open Session, a notification's click). Sessions is
 * global, so the rail's project stays where the builder left it. A tab that is closed comes back where it was (`closedTabs`), or at the end of
 * the strip when the stack no longer holds it. Sessions' composer takes the cursor once the tab shows.
 */
export function useOpenSession(): (chatId: ChatId) => Promise<void> {
  const open = useOpenChats().data;
  const patch = usePatchChat();
  const navigate = useNavigate();
  return async (chatId) => {
    const count = open?.length ?? 0;
    if (open?.some((chat) => chat.id === chatId) !== true) {
      const entry = closedTabs.take(chatId);
      await patch.mutateAsync({ chatId, tabPosition: Math.min(entry?.position ?? count, count) });
    }
    await navigate({ to: '/sessions', search: { chat: chatId } });
  };
}

/** What opening a task needs: the project to select, and the task whose drawer the Board opens. */
export interface TaskToOpen {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
}

/** Opens a task in the Board's drawer from anywhere (a chat's task row, the sealed chat's line). */
export function useOpenTask(): (task: TaskToOpen) => Promise<void> {
  const navigate = useNavigate();
  const { select } = useSelectedProject();
  return async (task) => {
    select(task.projectId);
    await navigate({ to: '/board', search: { task: task.taskId } });
  };
}
