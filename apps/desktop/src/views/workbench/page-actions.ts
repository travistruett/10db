import type { TaskId } from '@10db/contracts';
import { useRedoTurn, useStopPage } from '../../daemon/pass-queries';
import { usePostTaskMessage } from '../../daemon/thread-queries';
import type { PageActions } from './composer';

/**
 * What a page's composer does: Send posts to the task's thread, a plain Stop ends its turn, Stop and
 * Redo stops it and sends the draft. Sign Off has no route yet, so the composer offers it disabled.
 */
export function usePageActions(taskId: TaskId): PageActions {
  const post = usePostTaskMessage(taskId);
  const stop = useStopPage(taskId);
  const redo = useRedoTurn(taskId);
  return {
    send: async (draft) => {
      await post.mutateAsync(draft);
    },
    stop: async () => {
      await stop.mutateAsync();
    },
    redo: async (draft) => {
      await redo.mutateAsync(draft);
    },
    signOff: null,
  };
}
