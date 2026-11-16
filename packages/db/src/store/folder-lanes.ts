import {
  BatchState,
  passHoldsTasks,
  UNFINISHED_BATCH_STATES,
  WorkstreamState,
  type BatchId,
  type ProjectId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, eq, exists, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';

/** One thing that holds Your folder as a task does: a task's run, or a shared batch with its lanes. */
export type FolderLane =
  | {
      readonly kind: 'task';
      readonly taskId: TaskId;
      readonly workstreamId: WorkstreamId;
      readonly name: string;
    }
  | { readonly kind: 'batch'; readonly batchId: BatchId; readonly name: string };

/** States that hold the folder wherever the run is, from the first session to the end. */
const HOLDING: readonly WorkstreamState[] = [
  WorkstreamState.Starting,
  WorkstreamState.Running,
  WorkstreamState.HandingOff,
  WorkstreamState.Verifying,
  WorkstreamState.WaitingHuman,
  WorkstreamState.PausedLimit,
  WorkstreamState.Recovering,
  WorkstreamState.TakenOver,
];

/** States a run is waiting between steps in: it holds the folder once it has had a session. */
const BETWEEN: readonly WorkstreamState[] = [WorkstreamState.Queued, WorkstreamState.Held];

const FINISHED_BATCH: readonly BatchState[] = [
  BatchState.Shipped,
  BatchState.Closed,
  BatchState.Abandoned,
];

/**
 * What holds the project's checkout as a task does, from its rows (sessions spec §7.3):
 * - a run in Your folder (no worktree, not a pass's page), from its `STARTING` write until it lands or ends,
 *   so between steps, waiting on a person or paused it still holds the folder;
 * - a shared batch, from `CUTTING` until its switch back has run (`returnSha` is cleared then).
 * A pass holds the folder through its own row (`passHoldingFolder`).
 */
export function folderLanes(db: DbReader, projectId: ProjectId): FolderLane[] {
  const lanes: FolderLane[] = [];
  const passBatches = new Set(
    db
      .select({ batchId: schema.passes.batchId })
      .from(schema.passes)
      .where(eq(schema.passes.projectId, projectId))
      .all()
      .map((p) => p.batchId),
  );
  const sharedBatches = db
    .select()
    .from(schema.batches)
    .where(and(eq(schema.batches.projectId, projectId), isNull(schema.batches.worktreePath)))
    .all()
    .filter(
      (b) =>
        !passBatches.has(b.id) &&
        (UNFINISHED_BATCH_STATES.includes(b.state) ||
          (FINISHED_BATCH.includes(b.state) && b.returnSha !== null)),
    );
  for (const b of sharedBatches) lanes.push({ kind: 'batch', batchId: b.id, name: b.title });
  const inBatch = new Set(sharedBatches.map((b) => b.id));

  const runs = db
    .select({
      id: schema.workstreams.id,
      taskId: schema.workstreams.taskId,
      batchId: schema.workstreams.batchId,
      state: schema.workstreams.state,
      title: schema.tasks.title,
      passId: schema.tasks.passId,
      worktreePath: schema.batches.worktreePath,
      started: exists(
        db
          .select({ one: schema.sessions.id })
          .from(schema.sessions)
          .where(eq(schema.sessions.workstreamId, schema.workstreams.id)),
      ),
    })
    .from(schema.workstreams)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.workstreams.taskId))
    .leftJoin(schema.batches, eq(schema.batches.id, schema.workstreams.batchId))
    .where(eq(schema.workstreams.projectId, projectId))
    .all();
  const holdingPasses = new Map(
    db
      .select({ id: schema.passes.id, state: schema.passes.state })
      .from(schema.passes)
      .where(eq(schema.passes.projectId, projectId))
      .all()
      .map((p) => [p.id, p.state]),
  );
  for (const run of runs) {
    if (run.worktreePath !== null) continue;
    // A batch's lanes are held by the batch; a pass's pages by the pass.
    if (run.batchId !== null && inBatch.has(run.batchId)) continue;
    const pass = run.passId === null ? undefined : holdingPasses.get(run.passId);
    if (pass !== undefined && passHoldsTasks(pass)) continue;
    const holds = HOLDING.includes(run.state) || (BETWEEN.includes(run.state) && run.started);
    if (holds)
      lanes.push({ kind: 'task', taskId: run.taskId, workstreamId: run.id, name: run.title });
  }
  return lanes;
}
