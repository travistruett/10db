import { getTask, type DbReader, type WorkstreamRow } from '@10db/db';
import { GitTrustError, GitTrustFailure, PassFolderOffBranchError, type Git } from '../git';
import { checkoutOf } from './checkout';
import { laneBranchOf, type LaneBranch } from './lane-branch';
import { runCommits } from './run-commits';

/** What landing a run's lane branch came to. */
export type LaneLanding =
  | { readonly kind: 'not_a_lane' | 'nothing' }
  | { readonly kind: 'landed'; readonly sha: string }
  | { readonly kind: 'refused'; readonly reason: string };

/** The landing's operation id: a rerun after a crash finds the commit it made instead of a second. */
const landingOp = (row: WorkstreamRow): string => `land-${row.id}`;

/** A landing that lost a race for the base's tip, which one more try from the new tip may win. */
const raced = (error: unknown): boolean =>
  error instanceof GitTrustError &&
  error.detail.kind === GitTrustFailure.Ref &&
  error.detail.reason === 'raced';

const refused = (lane: LaneBranch, why: string): LaneLanding => ({
  kind: 'refused',
  reason: `Nothing reached ${lane.base}: the work on branch ${lane.lane} could not land (${why}).`,
});

/**
 * Lands a Your-folder run's lane branch on its base as one commit, once its checks have passed: the
 * files its commits changed, taken from the lane's tip onto the base's tip (`Git.landPaths`). A run
 * on no lane branch, or one that committed nothing, lands nothing.
 *
 * A file the base changed since the lane started, in a way the lane's tip does not hold, is never
 * taken from the lane: that would undo the base's change, so the landing is refused instead. A base
 * that moves between that check and the landing is checked once more from its new tip. A refusal
 * (Your folder on another branch, the base moved again, a filter) writes nothing and says why; the
 * lane branch stays.
 */
export async function landLaneWork(
  deps: { readonly db: DbReader; readonly git: Git },
  row: WorkstreamRow,
): Promise<LaneLanding> {
  const lane = laneBranchOf(row);
  if (lane === null) return { kind: 'not_a_lane' };
  const checkout = checkoutOf(deps.db, row);
  try {
    const { ranges } = await runCommits(deps, row, checkout, lane.base, lane.base);
    const [range] = ranges;
    if (range === undefined) return { kind: 'nothing' };
    const paths = await deps.git.filesChangedBetween(checkout, range.base, range.head);
    if (paths.length === 0) return { kind: 'nothing' };
    for (let attempt = 1; ; attempt += 1) {
      const tip = await deps.git.branchTip(checkout, lane.base);
      if (tip === null) return refused(lane, `branch ${lane.base} is gone`);
      const undone = await deps.git.changesMissing({
        repo: checkout,
        tip: range.head,
        other: tip,
        from: range.base,
        paths,
      });
      if (undone.length > 0)
        return {
          kind: 'refused',
          reason: `Nothing reached ${lane.base}: ${lane.base} changed ${undone.join(', ')} after this run started, and its work on branch ${lane.lane} does not hold that change, so landing it would undo it. Bring the change into the run's work, then Retry to land it.`,
        };
      try {
        const landed = await deps.git.landPaths({
          repo: checkout,
          branch: lane.base,
          from: range.head,
          paths,
          message: getTask(deps.db, row.taskId).title,
          opId: landingOp(row),
          expect: tip,
          // The run's failed card says why it did not land; git raises no card of its own.
          willRetry: true,
        });
        return landed.sha === null ? { kind: 'nothing' } : { kind: 'landed', sha: landed.sha };
      } catch (error) {
        if (attempt === 1 && raced(error)) continue;
        throw error;
      }
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const next =
      error instanceof PassFolderOffBranchError
        ? `Put Your folder back on ${lane.base} and Retry to land it`
        : 'Retry to land it';
    return refused(lane, `${why}. ${next}`);
  }
}
