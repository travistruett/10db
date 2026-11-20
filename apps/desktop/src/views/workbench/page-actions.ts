import type { ConversationId, TaskId } from '@10db/contracts';
import { useRedoConversation, useSendConversationMessage } from '../../daemon/conversation-queries';
import { usePostTaskMessage, useStopPage } from '../../daemon/pass-queries';
import type { PageActions } from './page-composer';

/**
 * What a page's composer does: Send posts to the task's conversation, a plain Stop ends its turn, Stop
 * and Redo stops it and sends the draft. A page whose task
 * has no conversation yet sends its first message through the task's own intake, which makes one.
 */
export function usePageActions(taskId: TaskId, conversationId: ConversationId | null): PageActions {
  const post = useSendConversationMessage();
  const first = usePostTaskMessage(taskId);
  const stop = useStopPage(taskId);
  const redo = useRedoConversation();
  return {
    send: async ({ text, pictures }) => {
      if (conversationId === null) await first.mutateAsync({ text, pictures });
      else await post.mutateAsync({ conversationId, text, pictures: [...pictures] });
    },
    stop: async () => {
      await stop.mutateAsync();
    },
    redo: async ({ text, pictures }) => {
      // A turn runs, so the task's conversation is there.
      if (conversationId === null) throw new Error('This page has no turn to redo');
      await redo.mutateAsync({ conversationId, text, pictures: [...pictures] });
    },
  };
}
