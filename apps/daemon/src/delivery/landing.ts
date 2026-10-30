import {
  ConflictError,
  landingTarget,
  type BatchDto,
  type LandingTarget,
  type ProjectDto,
  type TaskDto,
} from '@10db/contracts';
import { startCards, type Card } from './cards';
import { networkCall, type DeliveryContext } from './context';

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

/** The batch's landing as a task would state it: where it is built from and how it merges. */
export function batchLanding(batch: Pick<BatchDto, 'baseBranch' | 'autoMerge'>): LandingTarget {
  return { baseBranch: batch.baseBranch, autoMerge: batch.autoMerge };
}

const same = (a: LandingTarget, b: LandingTarget): boolean =>
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
