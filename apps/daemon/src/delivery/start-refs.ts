import { NotFoundError, WorkstreamId } from '@10db/contracts';
import { getBatch, getWorkstream, type DbReader } from '@10db/db';
import type { Git } from '../git';
import type { Logger } from '../log';

/**
 * Where a task's start on its batch's merged base is kept reachable (`Git.mergedCommit`), one ref per
 * workstream, in the repository its batch's worktree shares.
 */
export const START_REFS = 'refs/10db/starts/';

export const startRef = (id: WorkstreamId): string => `${START_REFS}${id}`;

/** True when the workstream the ref names belongs to a batch that still has its worktree. */
function isLive(db: DbReader, ref: string): boolean {
  const id = WorkstreamId.safeParse(ref.slice(START_REFS.length));
  if (!id.success) return false;
  try {
    const { batchId } = getWorkstream(db, id.data);
    return batchId !== null && getBatch(db, batchId).worktreePath !== null;
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}

/**
 * Deletes the kept starts in `main`'s repository that no live worktree batch's task holds: its
 * workstream is gone or unknown, or its batch finished and dropped its worktree. A ref git won't
 * delete is logged and left for the next sweep.
 */
export async function dropOrphanStarts(
  deps: { readonly db: DbReader; readonly git: Git; readonly logger: Logger },
  main: string,
): Promise<void> {
  for (const ref of await deps.git.keptRefs(main, START_REFS)) {
    if (isLive(deps.db, ref)) continue;
    try {
      await deps.git.deleteKeptRef(main, ref);
      deps.logger.info({ ref }, 'orphaned task start dropped');
    } catch (error) {
      deps.logger.warn(
        { ref, err: error instanceof Error ? error.message : String(error) },
        'orphaned task start kept',
      );
    }
  }
}
