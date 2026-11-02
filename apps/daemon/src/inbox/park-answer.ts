import {
  columnNameKey,
  DEFAULT_BOARD_COLUMN,
  isTerminal,
  PARKED_NOTICE_KEY,
  TaskStatus,
  type BoardColumnId,
  type InboxItemDto,
  type Notice,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getTask,
  getWorkstreamRow,
  insertBoardColumn,
  listBoardColumns,
  moveTask,
  setWorkstreamNotice,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Logger } from '../log';

/** What the task's drawer says of a run the builder parked: the question, and what they answered. */
function parkedNotice(item: InboxItemDto): Notice {
  const answer = item.answer;
  const note = answer?.note?.trim();
  return {
    key: PARKED_NOTICE_KEY,
    tone: 'info',
    line: `Parked after your answer to: ${item.title}`,
    body: [
      `Question: ${item.title}`,
      ...(item.body.trim() === '' ? [] : [item.body.trim()]),
      `Your answer: ${answer?.choice ?? ''}${note ? ` (${note})` : ''}`,
      'The run stopped and no review followed. Move the task out of the Icebox and start it when you can answer.',
    ].join('\n\n'),
  };
}

/** The column a parked task goes to: the project's Icebox, else its first column, else a new Icebox. */
function parkingColumn(ctx: WriteContext, task: ReturnType<typeof getTask>): BoardColumnId {
  const columns = listBoardColumns(ctx.tx, task.projectId);
  const key = columnNameKey(DEFAULT_BOARD_COLUMN);
  const found = columns.find((c) => columnNameKey(c.name) === key) ?? columns[0];
  return (found ?? insertBoardColumn(ctx, task.projectId, { name: DEFAULT_BOARD_COLUMN })).id;
}

/**
 * What the daemon does when the builder answers a lane's question with "Park the task": for every run
 * the card asked for, the run stops (as a cancel from the Board does, so no review round follows), the
 * task goes to the project's Icebox, and the run keeps a notice with the question and the answer for
 * the task's drawer. A run that already ended is left alone. A failure is logged and ends nothing
 * else: the card keeps its answer, so the builder can park the task by hand.
 */
export function createParkAnswers(deps: {
  readonly state: StateStore;
  /** Ends the workstream's session (if any) and marks it cancelled, as a cancel from the Board does. */
  cancel(id: WorkstreamId): Promise<void>;
  readonly log: Logger;
}): (item: InboxItemDto) => void {
  async function park(item: InboxItemDto, id: WorkstreamId): Promise<void> {
    if (isTerminal(getWorkstreamRow(deps.state.db, id).state)) return;
    await deps.cancel(id);
    deps.state.write((ctx) => {
      const task = getTask(ctx.tx, getWorkstreamRow(ctx.tx, id).taskId);
      // Only an open task not parked already moves; a finished or removed one stays where it is.
      if (task.status === TaskStatus.Open && task.boardColumnId === null) {
        try {
          moveTask(ctx, task.id, { to: parkingColumn(ctx, task), after: null, before: null });
        } catch (error) {
          // A dependent that already started cannot wait on a parked task; the run is stopped anyway.
          deps.log.warn(
            { err: error, taskId: task.id },
            'the run was stopped but its task could not be parked',
          );
        }
      }
      setWorkstreamNotice(ctx, id, parkedNotice(item));
    });
  }

  return (item) => {
    for (const target of item.targets) {
      park(item, target.workstreamId).catch((error: unknown) => {
        deps.log.error(
          { err: error, workstreamId: target.workstreamId },
          'could not park a task after the builder’s answer',
        );
      });
    }
  };
}
