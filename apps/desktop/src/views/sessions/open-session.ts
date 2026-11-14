import type { ChatId, ProjectId } from '@10db/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useOpenChats, usePatchChat } from '../../daemon/chat-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { closedTabs } from './closed-tabs';

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
