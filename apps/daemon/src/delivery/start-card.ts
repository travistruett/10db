import {
  BatchId,
  BatchStartInput,
  InvalidError,
  TaskId,
  type InboxAnswer,
  type InboxItemDto,
} from '@10db/contracts';
import { cancelRefusedStartTask, getTask } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { START_REFUSED_DETAIL, StartChoice, startTitle } from './cards';
import type { BatchStarter } from './start';

const Refused = z.object({ title: z.string().optional(), batchId: BatchId.optional() });

/**
 * Acts on a refused start's answer before the inbox records it. Retry start asks the starter to
 * start the same tasks again, as the first request did; a start that is refused in the request
 * itself (a task already running, an unfinished dependency) throws, which keeps the card open and
 * tells the builder why, and one refused later in the background raises a fresh card. Cancel task
 * removes each task the card names, as removing it from the Board does, though a run the refused
 * cut cancelled before it had a session does not count as a start, and a task started again after a
 * failed run is closed as the Board's Close does, and one started again after a finished run (reopened)
 * or a run cancelled after a session is removed with that run kept; a task that has started since,
 * or that another task waits on, throws and keeps the card open. Any other label changes
 * nothing.
 */
export function createStartCardAnswers(deps: {
  readonly state: StateStore;
  readonly starter: BatchStarter;
}): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const refused = Refused.safeParse(item.detail?.[START_REFUSED_DETAIL]);
    const taskIds = z.array(TaskId).safeParse(item.detail?.['taskIds']);
    if (!refused.success || !taskIds.success) return;
    switch (answer.choice) {
      case StartChoice.Retry: {
        // A card that kept no title (one refused before its batch had one) is titled after its tasks.
        const title =
          refused.data.title ?? startTitle(taskIds.data.map((id) => getTask(deps.state.db, id)));
        const request = BatchStartInput.safeParse({
          ...refused.data,
          title,
          taskIds: taskIds.data,
        });
        if (!request.success) throw new InvalidError('This card has no start to repeat');
        deps.starter.startBatch(item.projectId, request.data);
        return;
      }
      case StartChoice.Cancel:
        deps.state.write((w) => {
          for (const taskId of taskIds.data) cancelRefusedStartTask(w, taskId);
        });
        return;
    }
  };
}
