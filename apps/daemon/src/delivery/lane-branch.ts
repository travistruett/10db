import { Delivery, type ProjectId, type TaskId, type WorkstreamId } from '@10db/contracts';
import { getProject, getTask, passHoldingTask, type DbReader } from '@10db/db';
import { laneBranchName } from './branch-name';

/** What naming a run's lane branch reads of its workstream row. */
export interface LaneRun {
  readonly id: WorkstreamId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly batchId: unknown;
  /** The base the run works on: the branch Your folder was on when its first session started. */
  readonly branch: string | null;
}

/** The `detail` key of a failed run's card naming the lane branch that holds its work. */
export const LANE_BRANCH_DETAIL = 'laneBranch';

/** A run's lane branch and the base it lands on. */
export interface LaneBranch {
  readonly lane: string;
  readonly base: string;
}

/**
 * The branch a run commits on when it works in Your folder of a Commit Directly project with a gate,
 * outside any batch or pass: its own lane branch, so nothing reaches the base until the run's final
 * gate passed and it lands. Null for every other run, which commits where it always has; with no
 * gate there is none for a run's unfinished commits to fail, and the builder checks each run.
 */
export function laneBranchOf(db: DbReader, run: LaneRun): LaneBranch | null {
  if (run.batchId !== null || run.branch === null) return null;
  const project = getProject(db, run.projectId);
  if (project.delivery !== Delivery.Local || project.gateCommand === null) return null;
  if (passHoldingTask(db, getTask(db, run.taskId)) !== undefined) return null;
  return { lane: laneBranchName(run.id), base: run.branch };
}
