import { basename } from 'node:path';
import { NotFoundError, WorkstreamId } from '@10db/contracts';
import { getBatch, getWorkstream, type DbReader } from '@10db/db';
import type { Git } from '../git';
import type { Logger } from '../log';

/**
 * Where this daemon keeps its tasks' starts on their batch's merged base (`Git.mergedCommit`), one ref
 * per workstream, in the repository its batches' worktrees share. The refs sit under the level its
 * worktree root is named for, from its data dir, so a second daemon on the same repository (a dev
 * daemon with a data dir of its own) never takes this one's for orphans.
 */
export const startRefs = (worktreeRoot: string): string =>
  `refs/10db/${basename(worktreeRoot)}/starts/`;

export const startRef = (worktreeRoot: string, id: WorkstreamId): string =>
  `${startRefs(worktreeRoot)}${id}`;

/** True when the workstream the ref names belongs to a batch that still has its worktree. */
function isLive(db: DbReader, prefix: string, ref: string): boolean {
  const id = WorkstreamId.safeParse(ref.slice(prefix.length));
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
 * Deletes this daemon's kept starts in `main`'s repository that no live worktree batch's task holds:
 * its workstream is gone or unknown, or its batch finished and dropped its worktree. Another daemon's
 * are never read. A ref git won't delete is logged and left for the next sweep.
 */
export async function dropOrphanStarts(
  deps: {
    readonly db: DbReader;
    readonly git: Git;
    readonly logger: Logger;
    readonly worktreeRoot: string;
  },
  main: string,
): Promise<void> {
  const prefix = startRefs(deps.worktreeRoot);
  for (const ref of await deps.git.keptRefs(main, prefix)) {
    if (isLive(deps.db, prefix, ref)) continue;
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
