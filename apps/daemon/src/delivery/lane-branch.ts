import { Delivery, type ProjectId, type TaskId, type WorkstreamId } from '@10db/contracts';
import { getProject, getTask, passHoldingTask, type DbReader } from '@10db/db';
import { laneBranchName } from './branch-name';

/** What choosing a run's lane branch reads of its workstream row. */
export interface LaneRun {
  readonly id: WorkstreamId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly batchId: unknown;
}

/** What reading a run's pinned lane branch takes of its workstream row. */
export interface PinnedLaneRun {
  /** The base the run works on: the branch Your folder was on when its first session started. */
  readonly branch: string | null;
  /** The lane branch pinned with `branch`, or null for a run that commits on its base. */
  readonly laneBranch: string | null;
}

/** The `detail` key of a failed run's card naming the lane branch that holds its work. */
export const LANE_BRANCH_DETAIL = 'laneBranch';

/** A run's lane branch and the base it lands on. */
export interface LaneBranch {
  readonly lane: string;
  readonly base: string;
}

/**
 * The lane branch a run starting now would commit on, pinned with its base as its first session
 * starts: a run in Your folder of a Commit Directly project with a gate, outside any batch or pass,
 * gets its own, so nothing reaches the base until the run's final gate passed and it lands. Null for
 * every other run, which commits where it always has; with no gate there is none for a run's
 * unfinished commits to fail, and the builder checks each run.
 */
export function laneBranchFor(db: DbReader, run: LaneRun): string | null {
  if (run.batchId !== null) return null;
  const project = getProject(db, run.projectId);
  if (project.delivery !== Delivery.Local || project.gateCommand === null) return null;
  if (passHoldingTask(db, getTask(db, run.taskId)) !== undefined) return null;
  return laneBranchName(run.id);
}

/**
 * The lane branch the run commits on and the base it lands on, as pinned on its row; null for a run
 * that commits on its base. Read from the row alone, so a project changed mid-run moves nothing.
 */
export function laneBranchOf(run: PinnedLaneRun): LaneBranch | null {
  if (run.laneBranch === null || run.branch === null) return null;
  return { lane: run.laneBranch, base: run.branch };
}
