import {
  ACTIVE_STATES,
  ConflictError,
  landingTarget,
  ProjectLanding,
  TaskStatus,
  UNFINISHED_BATCH_STATES,
  type BatchDto,
  type BatchId,
  type LandingTarget,
  type Notice,
  type ProjectDto,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { listBatches, listTasks, listWorkstreams } from '@10db/db';
import { startCards, type Card } from './cards';
import { networkCall, type DeliveryContext } from './context';
import { landingNotices } from './notices';

/**
 * The refusal for a batch that takes its base from a branch the task named, when origin has no
 * such branch; null when it has it, or when the base is the project's own, whose absence the
 * fetch reports. Throws the GitNetworkError when origin can't be asked.
 */
export async function missingLandingBranch(
  ctx: DeliveryContext,
  project: Pick<ProjectDto, 'repoPath' | 'baseBranch'>,
  batch: Pick<BatchDto, 'baseBranch'>,
  signal: AbortSignal,
): Promise<Card | null> {
  if (batch.baseBranch === project.baseBranch) return null;
  const there = await ctx.git.branchOnOrigin(
    project.repoPath,
    batch.baseBranch,
    networkCall(ctx, signal),
  );
  return there ? null : startCards.branchMissing(batch.baseBranch);
}

/**
 * A notice when the branch a batch lands in lacks commits the project's base has, so a task still
 * filed against a retired integration branch is not started unwarned; null when it holds the base,
 * when the base is the batch's own, or when origin can't be asked (the start's own fetch refuses that).
 * Fetches the base into origin's remote-tracking ref, as the batch's own fetch does for its branch.
 */
export async function branchBehindBase(
  ctx: DeliveryContext,
  project: Pick<ProjectDto, 'repoPath' | 'baseBranch'>,
  batch: Pick<BatchDto, 'baseBranch'>,
  signal: AbortSignal,
): Promise<Notice | null> {
  if (batch.baseBranch === project.baseBranch) return null;
  try {
    await ctx.git.fetch(project.repoPath, project.baseBranch, networkCall(ctx, signal));
    const base = `refs/remotes/origin/${project.baseBranch}`;
    const branch = `refs/remotes/origin/${batch.baseBranch}`;
    if (await ctx.git.isAncestor(project.repoPath, base, branch)) return null;
    const missing = (await ctx.git.commitsSince(project.repoPath, branch, base)).length;
    return landingNotices.behind(batch.baseBranch, project.baseBranch, Math.max(missing, 1));
  } catch (error) {
    ctx.logger.warn({ baseBranch: batch.baseBranch, err: error }, 'landing branch not compared');
    return null;
  }
}

/**
 * A notice when no other open work lands in the branch a batch lands in, so a task still filed
 * against a retired branch is not started unwarned even when the branch is level with the base;
 * null when the branch is the project's base, or the branch it lands new tasks in, or when a task
 * with an active workstream (not one of `own`, the tasks this batch starts) or an unfinished batch
 * other than this one lands there. A task only filed against the branch, wherever it sits on the
 * Board, a done or removed task and a shipped batch are no use. `sameStart` is everything the one
 * start request made, which is no use to a batch of it either: the tasks and batches of a start that
 * makes several batches (a copy per dependency group) in one unused branch.
 */
export function branchUnused(
  ctx: DeliveryContext,
  project: Pick<ProjectDto, 'id' | 'baseBranch' | 'landing' | 'landingBranch'>,
  batch: Pick<BatchDto, 'id' | 'baseBranch'>,
  own: Iterable<TaskId>,
  sameStart?: SameStart,
): Notice | null {
  const branch = batch.baseBranch;
  if (branch === project.baseBranch) return null;
  if (project.landing === ProjectLanding.Branch && project.landingBranch === branch) return null;
  const mine = new Set(own);
  // Work under way is use; a task merely filed against the branch is not, or two follow-ups still
  // filed against a retired branch would hide each other's warning.
  const underWay = new Set(
    listWorkstreams(ctx.state.db, { projectId: project.id, states: ACTIVE_STATES }).map(
      (w) => w.taskId,
    ),
  );
  const task = listTasks(ctx.state.db, project.id).find(
    (t) =>
      t.status === TaskStatus.Open &&
      underWay.has(t.id) &&
      !mine.has(t.id) &&
      !sameStart?.tasks.has(t.id) &&
      taskTarget(project, t).baseBranch === branch,
  );
  if (task !== undefined) return null;
  const batchUsing = listBatches(ctx.state.db, {
    projectId: project.id,
    states: UNFINISHED_BATCH_STATES,
  }).find((b) => b.id !== batch.id && !sameStart?.batches.has(b.id) && b.baseBranch === branch);
  if (batchUsing !== undefined) return null;
  return landingNotices.unused(branch, project.baseBranch);
}

/**
 * The tasks and batches one start request makes. The batch ids fill in as the request writes its
 * batches, which is before any of its cuts run.
 */
export interface SameStart {
  readonly tasks: ReadonlySet<TaskId>;
  readonly batches: Set<BatchId>;
}

/** Every notice a batch's landing branch earns at its start: behind the base, and used by nothing else. */
export async function landingWarnings(
  ctx: DeliveryContext,
  project: Pick<ProjectDto, 'id' | 'repoPath' | 'baseBranch' | 'landing' | 'landingBranch'>,
  batch: Pick<BatchDto, 'id' | 'baseBranch'>,
  own: Iterable<TaskId>,
  signal: AbortSignal,
  sameStart?: SameStart,
): Promise<Notice[]> {
  const behind = await branchBehindBase(ctx, project, batch, signal);
  return [behind, branchUnused(ctx, project, batch, own, sameStart)].filter((n) => n !== null);
}

/** The batch's landing as a task would state it: where it is built from and how it merges. */
export function batchLanding(batch: Pick<BatchDto, 'baseBranch' | 'autoMerge'>): LandingTarget {
  return { baseBranch: batch.baseBranch, autoMerge: batch.autoMerge };
}

export const same = (a: LandingTarget, b: LandingTarget): boolean =>
  a.baseBranch === b.baseBranch && a.autoMerge === b.autoMerge;

/** How a landing reads in a refusal: "merges into main when checks pass". */
function describe(target: LandingTarget): string {
  return target.autoMerge
    ? `merges into ${target.baseBranch} when checks pass`
    : `is held for your review (pull request against ${target.baseBranch})`;
}

/** Where one task lands, given its project's base branch. */
export function taskTarget(project: Pick<ProjectDto, 'baseBranch'>, task: TaskDto): LandingTarget {
  return landingTarget(task.landing, project.baseBranch);
}

/**
 * The one landing the tasks share, which a batch of them takes. Tasks that land differently can't
 * share a pull request, so the first that differs from the first task is refused, naming both.
 * `shared` names what they share: "branch", "worktree".
 */
export function sharedLanding(
  project: Pick<ProjectDto, 'baseBranch'>,
  tasks: readonly TaskDto[],
  shared: string,
): LandingTarget {
  const [first, ...rest] = tasks;
  if (first === undefined) return { baseBranch: project.baseBranch, autoMerge: true };
  const target = taskTarget(project, first);
  const other = rest.find((task) => !same(taskTarget(project, task), target));
  if (other !== undefined)
    throw new ConflictError(
      `${first.title} and ${other.title} share a ${shared} but land differently: ${first.title} ${describe(target)}, ${other.title} ${describe(taskTarget(project, other))}. Start them one after the other, or give them the same landing.`,
    );
  return target;
}

/** Refuses tasks whose landing is not the batch's they would join. */
export function joinsLanding(
  project: Pick<ProjectDto, 'baseBranch'>,
  batch: BatchDto,
  tasks: readonly TaskDto[],
): void {
  const target = batchLanding(batch);
  const other = tasks.find((task) => !same(taskTarget(project, task), target));
  if (other !== undefined)
    throw new ConflictError(
      `Batch "${batch.title}" ${describe(target)}, but ${other.title} ${describe(taskTarget(project, other))}. Change where ${other.title} lands to match, or start it once the batch has shipped.`,
    );
}
