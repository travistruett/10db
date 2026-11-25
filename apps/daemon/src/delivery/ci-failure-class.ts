import type { RequiredCheckJobDto } from '@10db/contracts';

/**
 * Where a failing required check comes from, which decides what is done about it:
 * - `Base`: the same check also fails on the pull request's base branch, so fixing the pull request
 *   cannot help; it waits, and the base's own failure is raised once.
 * - `Change`: the base passes it, so the pull request's change broke it. Its Actions job is run again
 *   once first (`ciRerunStep`): one that passes then was flaky, and one that fails again gets a fix.
 * A job GitHub cancelled for want of a runner is neither: `followNoRunner` reruns it before this runs.
 */
export const CiFailureClass = { Base: 'base', Change: 'change' } as const;
export type CiFailureClass = (typeof CiFailureClass)[keyof typeof CiFailureClass];

/**
 * Sorts each failing check by name against the checks failing on the base. `base` null: the base
 * could not be read, so every check counts as the change's own.
 */
export function classifyCiFailures(
  failing: readonly RequiredCheckJobDto[],
  base: ReadonlySet<string> | null,
): { readonly base: RequiredCheckJobDto[]; readonly change: RequiredCheckJobDto[] } {
  const onBase = (job: RequiredCheckJobDto): boolean => base?.has(job.name) === true;
  return { base: failing.filter(onBase), change: failing.filter((job) => !onBase(job)) };
}
