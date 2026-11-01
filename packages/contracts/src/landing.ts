import { z } from 'zod';
import { BranchName } from './git-names';

/**
 * Where a new task lands unless it says otherwise: merged into the base branch, merged into the
 * branch the project names (`landingBranch`, such as an integration branch), or held for the builder.
 */
export const ProjectLanding = { Merge: 'merge', Branch: 'branch', Hold: 'hold' } as const;
export type ProjectLanding = (typeof ProjectLanding)[keyof typeof ProjectLanding];

export const DEFAULT_PROJECT_LANDING: ProjectLanding = ProjectLanding.Merge;

/**
 * Where one task's work lands: merged into the project's base branch when its checks pass, merged
 * into another branch of origin the same way, or left open for the builder to merge.
 */
export const TaskLanding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('base') }),
  z.object({ kind: z.literal('branch'), branch: BranchName }),
  z.object({ kind: z.literal('hold') }),
]);
export type TaskLanding = z.infer<typeof TaskLanding>;

/** The landing a new task starts with: what its project does by default. */
export function taskLandingFor(project: {
  readonly landing: ProjectLanding;
  readonly landingBranch: string | null;
}): TaskLanding {
  switch (project.landing) {
    case ProjectLanding.Merge:
      return { kind: 'base' };
    case ProjectLanding.Branch:
      // A branch default is only stored with its name; a stray row falls back to the base.
      return project.landingBranch === null
        ? { kind: 'base' }
        : { kind: 'branch', branch: project.landingBranch };
    case ProjectLanding.Hold:
      return { kind: 'hold' };
  }
}

/** The branch a task's batch is cut from and its pull request targets, and whether it merges by itself. */
export interface LandingTarget {
  readonly baseBranch: string;
  readonly autoMerge: boolean;
}

export function landingTarget(landing: TaskLanding, projectBase: string): LandingTarget {
  switch (landing.kind) {
    case 'base':
      return { baseBranch: projectBase, autoMerge: true };
    case 'branch':
      return { baseBranch: landing.branch, autoMerge: true };
    case 'hold':
      return { baseBranch: projectBase, autoMerge: false };
  }
}

/** True when both landings give the same pull request: one target, merged the same way. */
export function sameLanding(a: TaskLanding, b: TaskLanding, projectBase: string): boolean {
  const left = landingTarget(a, projectBase);
  const right = landingTarget(b, projectBase);
  return left.baseBranch === right.baseBranch && left.autoMerge === right.autoMerge;
}

/** Where the work will land, in the words the Board shows. */
export function landingText(landing: TaskLanding, projectBase: string): string {
  const target = landingTarget(landing, projectBase);
  return target.autoMerge
    ? `Merges into ${target.baseBranch} when checks pass`
    : `Held for your review: pull request against ${target.baseBranch}`;
}
