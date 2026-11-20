import type { ChatId, ProjectId, TaskId } from '@10db/contracts';
import { Text } from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useOpenChats, usePatchChat, useUnarchiveChat } from '../../daemon/chat-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { closedTabs } from './closed-tabs';

/**
 * Opens a session's tab from anywhere (the Inbox's Open Session, a notification's click, a link to a plan's
 * session). Sessions is global, so the rail's project stays where the builder left it. A tab that is closed
 * comes back where it was (`closedTabs`), or at the end of the strip when the stack no longer holds it; one
 * that is archived (a plan's session the migration archived) is unarchived once it has its tab. The closed
 * stack gives up its entry only after both worked. Sessions' composer takes the cursor once the tab shows.
 */
export function useOpenSession(): (chatId: ChatId) => Promise<void> {
  const open = useOpenChats().data;
  const patch = usePatchChat();
  const unarchive = useUnarchiveChat();
  const navigate = useNavigate();
  return async (chatId) => {
    const count = open?.length ?? 0;
    if (open?.some((chat) => chat.id === chatId) !== true) {
      const entry = closedTabs.list().find((held) => held.chatId === chatId) ?? null;
      const chat = await patch.mutateAsync({
        chatId,
        tabPosition: Math.min(entry?.position ?? count, count),
      });
      if (chat.archivedAt !== null) await unarchive.mutateAsync(chatId);
      closedTabs.take(chatId);
    }
    await navigate({ to: '/sessions', search: { chat: chatId } });
  };
}

/**
 * `useOpenSession` for a link on screen: the way to open, and the words to draw beside it when opening
 * failed (null otherwise; the next try clears them).
 */
export function useOpenSessionNotice(): {
  readonly open: (chatId: ChatId) => void;
  readonly notice: ReactNode;
} {
  const openSession = useOpenSession();
  const [failure, setFailure] = useState<string | null>(null);
  return {
    open: (chatId) => {
      setFailure(null);
      openSession(chatId).catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error));
      });
    },
    notice:
      failure === null ? null : (
        <Text size="xs" c="red" role="alert">
          {`Couldn't open the session: ${failure}`}
        </Text>
      ),
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
