import type { TaskId } from '@10db/contracts';
import { usePostTaskMessage } from '../../daemon/thread-queries';
import type { PageActions } from './composer';

/** Thrown for a page action the daemon offers no route for. */
export class PageActionUnavailableError extends Error {
  override readonly name = 'PageActionUnavailableError';
}

function unavailable(what: string): () => Promise<void> {
  return () => Promise.reject(new PageActionUnavailableError(`10db can't ${what} yet.`));
}

/** What a page's composer does: Send posts to the task's thread. */
export function usePageActions(taskId: TaskId): PageActions {
  const post = usePostTaskMessage(taskId);
  return {
    send: async (draft) => {
      await post.mutateAsync(draft);
    },
    stop: unavailable('stop a turn'),
    redo: unavailable('redo a turn'),
    signOff: unavailable('sign off a page'),
  };
}
