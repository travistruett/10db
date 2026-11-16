import { ConflictError, type PassId } from '@10db/contracts';
import { insertBuilderMessage, listPassTasks } from '@10db/db';
import type { StateStore } from '../events';
import { GitError } from '../git';

/**
 * Each page's first turn starts from a message: the builder's, else the task's description. A page the open
 * made a task for from a page name has none, so it waits for the builder's first word.
 */
export function postFirstMessages(
  state: StateStore,
  passId: PassId,
  firstMessage: string | undefined,
): void {
  state.write((ctx) => {
    for (const task of listPassTasks(ctx.tx, passId)) {
      const body = firstMessage ?? task.description;
      if (body.trim() !== '') insertBuilderMessage(ctx, task.id, { body, files: [] });
    }
  });
}

/** What an open that git refused reaches the builder as; any other error is passed on as it is. */
export function openFailure(error: unknown): unknown {
  if (error instanceof GitError)
    return new ConflictError(`Your folder could not be opened for a pass: ${error.message}`);
  return error;
}
