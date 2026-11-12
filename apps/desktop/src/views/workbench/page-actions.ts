import type { PassId, TaskId } from '@10db/contracts';
import { useSignOff } from '../../daemon/pass-close-queries';
import { useRedoTurn, useStopPage } from '../../daemon/pass-queries';
import { usePostTaskMessage } from '../../daemon/thread-queries';
import type { PageActions } from './composer';

/**
 * What a page's composer does: Send posts to the task's thread, a plain Stop ends its turn, Stop and
 * Redo stops it and sends the draft, and Sign Off signs the page off in its pass.
 */
export function usePageActions(passId: PassId, taskId: TaskId): PageActions {
  const post = usePostTaskMessage(taskId);
  const stop = useStopPage(taskId);
  const redo = useRedoTurn(taskId);
  const signOff = useSignOff();
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
    signOff: async () => {
      await signOff.mutateAsync({ passId, taskId });
    },
  };
}
