import { getTask, type DbReader, type WorkstreamRow } from '@10db/db';
import type { Git } from '../git';
import { checkoutOf } from './checkout';
import { laneBranchOf } from './lane-branch';
import { runCommits } from './run-commits';

/** What landing a run's lane branch came to. */
export type LaneLanding =
  | { readonly kind: 'not_a_lane' | 'nothing' }
  | { readonly kind: 'landed'; readonly sha: string }
  | { readonly kind: 'refused'; readonly reason: string };

/** The landing's operation id: a rerun after a crash finds the commit it made instead of a second. */
const landingOp = (row: WorkstreamRow): string => `land-${row.id}`;

/**
 * Lands a Your-folder run's lane branch on its base as one commit, once its checks have passed: the
 * files its commits changed, taken from the lane's tip onto the base's tip (`Git.landPaths`). A run
 * on no lane branch, or one that committed nothing, lands nothing. A refusal (Your folder on another
 * branch, the base moved meanwhile, a filter) writes nothing and says why; the lane branch stays.
 */
export async function landLaneWork(
  deps: { readonly db: DbReader; readonly git: Git },
  row: WorkstreamRow,
): Promise<LaneLanding> {
  const lane = laneBranchOf(deps.db, row);
  if (lane === null) return { kind: 'not_a_lane' };
  const checkout = checkoutOf(deps.db, row);
  try {
    const { ranges } = await runCommits(deps, row, checkout, lane.base, lane.base);
    const [range] = ranges;
    if (range === undefined) return { kind: 'nothing' };
    const paths = await deps.git.filesChangedBetween(checkout, range.base, range.head);
    if (paths.length === 0) return { kind: 'nothing' };
    const landed = await deps.git.landPaths({
      repo: checkout,
      branch: lane.base,
      from: range.head,
      paths,
      message: getTask(deps.db, row.taskId).title,
      opId: landingOp(row),
      willRetry: true,
    });
    return landed.sha === null ? { kind: 'nothing' } : { kind: 'landed', sha: landed.sha };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      kind: 'refused',
      reason: `Nothing reached ${lane.base}: the work on branch ${lane.lane} could not land (${why}). Put Your folder back on ${lane.base} and Retry to land it.`,
    };
  }
}
