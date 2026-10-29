import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BatchState, InvalidError, type BatchDto, type BatchId } from '@10db/contracts';
import { getBatch, getProject, transitionBatch, type WriteContext } from '@10db/db';
import { existsAsEntry, GitTrustError, WorktreeNotOursError } from '../git';
import { worktreeCards } from './cards';
import { raise, type DeliveryContext } from './context';
import { jobKey, JobQueue } from './jobs';
import { worktreeLockReason } from './worktree-cut';
import { withWorktreeLock } from './worktree-lock';
import { seedDirs, seedWorktree } from './worktree-seed';

/** What `ensureWorktreeWhole` found: a worktree kept, one made again, or a refusal with its card. */
export type Wholeness = 'whole' | 'replaced' | 'refused';

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Spec §5 Retry: keep a whole worktree (there, pinned, with an index, on the batch branch), else
 * replace it from the existing branch (a new locked worktree on it, with no new branch, plus the
 * seed). Refuses with a card
 * over a worktree on another branch, or a detached one, with uncommitted changes, over one git can't
 * read the branch or changes of, and over anything git doesn't list as 10db's; refuses, without
 * removing anything, a worktree git won't trust (the trust card explains). Uncommitted work is never
 * thrown away without the builder. Holds the batch's worktree lock throughout.
 */
export async function ensureWorktreeWhole(
  ctx: DeliveryContext,
  batch: BatchDto,
  signal: AbortSignal,
): Promise<Wholeness> {
  return withWorktreeLock(batch.id, () => makeWhole(ctx, getBatch(ctx.state.db, batch.id), signal));
}

async function makeWhole(
  ctx: DeliveryContext,
  batch: BatchDto,
  signal: AbortSignal,
): Promise<Wholeness> {
  const path = batch.worktreePath;
  const branch = batch.branch;
  if (path === null || branch === null)
    throw new InvalidError(`Batch "${batch.title}" has no worktree branch to make whole`);
  const project = getProject(ctx.state.db, batch.projectId);
  const main = project.repoPath;
  const inTheWay = (reason: string): Wholeness => {
    raise(ctx.inbox, batch.projectId, worktreeCards.inTheWay(batch, path, reason));
    return 'refused';
  };
  if (existsAsEntry(path)) {
    let gitDir: string | null = null;
    try {
      gitDir = (await ctx.git.gitDirs(path)).gitDir;
    } catch (error) {
      if (error instanceof GitTrustError) return 'refused';
      // Not a worktree git can read: replaced below, only if git lists it as 10db's.
      ctx.logger.warn({ batchId: batch.id, path, err: message(error) }, 'worktree unreadable');
    }
    if (gitDir !== null) {
      try {
        const current = await ctx.git.currentBranch(path);
        if (current === branch && existsSync(join(gitDir, 'index'))) return 'whole';
        if (current !== branch) {
          const changed = await ctx.git.changedPaths(path);
          if (changed.length > 0) {
            raise(
              ctx.inbox,
              batch.projectId,
              worktreeCards.notWhole(batch, path, current, changed),
            );
            return 'refused';
          }
        }
      } catch (error) {
        if (error instanceof GitTrustError) return 'refused';
        // A worktree whose branch or changes git can't read may hold work: never removed unseen.
        return inTheWay(`git can't read it (${message(error)})`);
      }
    }
  }
  try {
    await ctx.git.removeWorktree(main, path);
  } catch (error) {
    if (error instanceof GitTrustError) return 'refused';
    if (error instanceof WorktreeNotOursError) return inTheWay(error.why);
    throw error;
  }
  if (signal.aborted) return 'refused';
  await ctx.git.addWorktree({
    repo: main,
    path,
    branch,
    startPoint: null,
    lockReason: worktreeLockReason(batch.id),
  });
  try {
    const seeded = await seedWorktree({
      from: main,
      to: path,
      dirs: seedDirs(await ctx.git.ignoredDirectories(main), project.worktreeSeed),
      signal,
    });
    ctx.logger.info(
      {
        batchId: batch.id,
        path,
        files: seeded.files,
        links: seeded.links,
        skipped: seeded.skipped,
      },
      'worktree seeded',
    );
  } catch (error) {
    // Without its seed the worktree is not whole: the next Retry makes it again.
    await ctx.git.removeWorktree(main, path).catch((removal: unknown) => {
      ctx.logger.warn({ batchId: batch.id, path, err: message(removal) }, 'worktree left unseeded');
    });
    throw error;
  }
  const dropUninstalled = async (): Promise<void> => {
    await ctx.git.removeWorktree(main, path).catch((removal: unknown) => {
      ctx.logger.warn({ batchId: batch.id, path, err: message(removal) }, 'worktree left unseeded');
    });
  };
  const installed = await ctx.dependencies
    .refresh({ batch, project, path, signal })
    .catch(async (error: unknown) => {
      // A worktree without current packages must not look whole to the next Retry.
      await dropUninstalled();
      throw error;
    });
  if (installed.kind === 'failed' || installed.kind === 'aborted') {
    // Without current packages the worktree is not whole: the next Retry makes it again.
    await dropUninstalled();
    if (installed.kind === 'failed')
      raise(ctx.inbox, batch.projectId, worktreeCards.installFailed(batch, installed));
    return 'refused';
  }
  ctx.logger.info({ batchId: batch.id, path, branch }, 'batch worktree made again');
  return 'replaced';
}

/**
 * Makes a FAILED worktree batch's worktree whole, then moves it to OPEN with `then` in the same
 * transaction, and asks for a tick. A batch already OPEN only gets `then`. Resolves false when the
 * batch did not open: the worktree was refused (its card is raised), or the batch moved elsewhere.
 */
export async function reopenWhenWhole(
  ctx: DeliveryContext,
  batchId: BatchId,
  reason: string,
  signal: AbortSignal,
  then?: (w: WriteContext) => void,
): Promise<boolean> {
  const batch = getBatch(ctx.state.db, batchId);
  // A function, so the checks after an await are not narrowed away by the one before it.
  const stopped = (): boolean => signal.aborted;
  if (stopped()) return false;
  if (batch.state === BatchState.Failed) {
    let whole: Wholeness;
    try {
      whole = await ensureWorktreeWhole(ctx, batch, signal);
    } catch (error) {
      if (!stopped()) raise(ctx.inbox, batch.projectId, worktreeCards.notReopened(batch, error));
      return false;
    }
    if (whole === 'refused' || stopped()) return false;
  } else if (batch.state !== BatchState.Open) {
    return false;
  }
  const opened = ctx.state.write((w) => {
    const now = getBatch(w.tx, batchId);
    if (now.state === BatchState.Failed)
      transitionBatch(w, batchId, { to: BatchState.Open, patch: { failure: null }, reason });
    else if (now.state !== BatchState.Open) return false;
    then?.(w);
    return true;
  });
  if (!opened) return false;
  ctx.logger.info({ batchId, reason }, 'batch reopened');
  ctx.onWorkQueued();
  return true;
}

/** In the cut queue, make the worktree whole, then FAILED → OPEN and ask for a tick. */
export function reopenWorktreeBatch(
  ctx: DeliveryContext,
  batchId: BatchId,
  reason: string,
  then?: (w: WriteContext) => void,
): void {
  const project = getProject(ctx.state.db, getBatch(ctx.state.db, batchId).projectId);
  ctx.jobs.run(jobKey(project, JobQueue.Cut), async (signal) => {
    await reopenWhenWhole(ctx, batchId, reason, signal, then);
  });
}
