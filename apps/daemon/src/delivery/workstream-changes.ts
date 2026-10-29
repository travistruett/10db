import { existsSync } from 'node:fs';
import {
  ConflictError,
  NotFoundError,
  type WorkstreamChangesDto,
  type WorkstreamId,
} from '@10db/contracts';
import { getWorkstreamRow, type DbReader } from '@10db/db';
import type { Git } from '../git';
import { checkoutOf } from './checkout';

/** The most diff text one answer carries; the per-file counts always cover every file. */
export const MAX_CHANGES_DIFF_BYTES = 512 * 1024;

/**
 * What a workstream changed: the diff from the head it started at to the head of its checkout (its
 * batch's worktree, else the project's), for the builder to check.
 */
export async function workstreamChanges(
  deps: { readonly db: DbReader; readonly git: Git },
  id: WorkstreamId,
): Promise<WorkstreamChangesDto> {
  const row = getWorkstreamRow(deps.db, id);
  if (row.baseHead === null)
    throw new ConflictError(`Workstream ${id} has not started work in a checkout yet`);
  const checkout = checkoutOf(deps.db, row);
  if (!existsSync(checkout)) throw new NotFoundError('checkout of workstream', id);
  const [head, commits, changes] = await Promise.all([
    deps.git.head(checkout),
    deps.git.commitsSince(checkout, row.baseHead),
    deps.git.diffSince(checkout, row.baseHead, MAX_CHANGES_DIFF_BYTES),
  ]);
  return {
    baseHead: row.baseHead,
    head,
    commits,
    diff: changes.diff,
    truncated: changes.truncated,
    files: [...changes.files],
  };
}
