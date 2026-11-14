import {
  latestPerTask,
  shipReadiness,
  TaskMessageKind,
  type ProjectId,
  type BatchId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getBatch,
  getProject,
  getTask,
  getWorkstreamRow,
  insertSystemNotice,
  listTaskThread,
  listWorkstreams,
  markSkipFollowUpStarted,
  patchTask,
  pendingSkipFollowUps,
  type DbReader,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { followUpStart, type SourceState } from './follow-up-start';

// A follow-up of Run these now starts from where its source stands when it starts, read fresh each
// time, so a pull request merged between the press and the start starts from the base.

/** The source run's batch and pull request as they stand now. */
export function sourceStateOf(db: DbReader, sourceWorkstreamId: WorkstreamId): SourceState {
  const row = getWorkstreamRow(db, sourceWorkstreamId);
  const project = getProject(db, row.projectId);
  if (row.batchId === null)
    return { batch: null, readiness: 'ready', delivery: project.delivery, pullRequest: null };
  const batch = getBatch(db, row.batchId);
  const members = latestPerTask(listWorkstreams(db, { batchId: batch.id }));
  return {
    batch: batch.state,
    readiness: shipReadiness(members.map((m) => m.state)),
    delivery: project.delivery,
    pullRequest: batch.pr?.state ?? null,
  };
}

export interface FollowUpStarts {
  /** Starts the task as a new member of the open batch, as a task added to it starts. */
  join(projectId: ProjectId, taskId: TaskId, batchId: BatchId): void;
  /** Starts the task as the Board's Start does. */
  base(taskId: TaskId): void;
}

export interface SkipFollowUpDeps {
  readonly state: StateStore;
  readonly starts: FollowUpStarts;
  readonly log: Logger;
}

/**
 * Starts each pending follow-up whose source lets it, and stamps it started; one that waits is
 * looked at again on the next batch or run change, and at the next start-up.
 */
export function startPendingSkipFollowUps(deps: SkipFollowUpDeps): void {
  const db = deps.state.db;
  for (const follow of pendingSkipFollowUps(db)) {
    try {
      const start = followUpStart(sourceStateOf(db, follow.sourceWorkstreamId));
      if (start.kind === 'wait') {
        if (start.reason !== null) sayWhyItWaits(deps, follow.taskId, start.reason);
        continue;
      }
      const task = getTask(db, follow.taskId);
      // A start a crash cut off before its stamp already made the run: it is only stamped.
      if (task.workstreamId === null) {
        const note = start.kind === 'base' ? start.note : null;
        if (note !== null)
          deps.state.write((ctx) =>
            patchTask(ctx, task.id, { description: `${task.description}\n\n${note}` }),
          );
        const source = getWorkstreamRow(db, follow.sourceWorkstreamId);
        if (start.kind === 'join' && source.batchId !== null)
          deps.starts.join(task.projectId, task.id, source.batchId);
        else deps.starts.base(task.id);
      }
      deps.state.write((ctx) => {
        markSkipFollowUpStarted(ctx, task.id);
      });
    } catch (error) {
      deps.log.warn(
        { taskId: follow.taskId, err: error instanceof Error ? error.message : String(error) },
        'a skip follow-up could not start',
      );
    }
  }
}

/** Tells the follow-up's task why it waits, once: a pass over it again with the same reason writes nothing. */
function sayWhyItWaits(deps: SkipFollowUpDeps, taskId: TaskId, reason: string): void {
  deps.state.write((ctx) => {
    const said = listTaskThread(ctx.tx, taskId).findLast((m) => m.kind === TaskMessageKind.Notice);
    if (said?.body !== reason) insertSystemNotice(ctx, taskId, reason);
  });
}

/**
 * `startPendingSkipFollowUps` for the bus: a start's own events call it again while it runs, so that
 * call only asks for one more pass, which runs once this one has stamped what it started.
 */
export function skipFollowUpStarter(deps: SkipFollowUpDeps): () => void {
  const pass = { running: false, again: false };
  const askedAgain = (): boolean => pass.again;
  return () => {
    if (pass.running) {
      pass.again = true;
      return;
    }
    pass.running = true;
    try {
      do {
        pass.again = false;
        startPendingSkipFollowUps(deps);
        // Read through a call: a start inside the pass may have set it.
      } while (askedAgain());
    } finally {
      pass.running = false;
    }
  };
}
