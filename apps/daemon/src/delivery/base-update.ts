import type { BatchDto, BatchId } from '@10db/contracts';
import {
  getBatch,
  getProject,
  getWorkstreamRow,
  listWorkstreams,
  patchBatch,
  patchWorkstream,
} from '@10db/db';
import type { BranchMerge } from '../git';
import { baseCards, detailOf } from './cards';
import { networkCall, raise, type DeliveryContext } from './context';
import { PNPM_LOCKFILE } from './worktree-dependencies';

/** What happened to a batch's branch before its gate (`decisions/2026-10-29-gate-with-base.md`). */
export type BaseUpdate =
  /** The branch holds its base as origin has it now. */
  | { readonly kind: 'up_to_date' }
  /**
   * The base was merged into the worktree batch's branch, which is now at `head`; the batch's base is
   * now `base`. `note` says what went wrong after the merge, for the gate's evidence.
   */
  | {
      readonly kind: 'merged';
      readonly base: string;
      readonly head: string;
      readonly note: string | null;
    }
  /** The gate tests the branch as it is; `note` says why, for its evidence. */
  | { readonly kind: 'not_merged'; readonly note: string }
  /** Shutdown or a cancel stopped it: no gate runs. */
  | { readonly kind: 'aborted' };

export interface BaseUpdates {
  /**
   * Fetches the batch's base branch, then brings it into a worktree batch's branch so its gate tests
   * what the pull request would merge. A batch in the builder's own checkout is never merged into: it
   * is only told how far behind its base it is. Never throws: what kept the base out is the note.
   */
  beforeGate(batchId: BatchId, signal: AbortSignal): Promise<BaseUpdate>;
}

/** What a gate's evidence or card says about its base: why it ran without it, or what went wrong. */
export function gateNote(update: BaseUpdate): string | null {
  switch (update.kind) {
    case 'merged':
    case 'not_merged':
      return update.note;
    case 'up_to_date':
    case 'aborted':
      return null;
  }
}

/** The files a note names before it counts the rest. */
const NAMED_PATHS = 10;

function named(paths: readonly string[]): string {
  const shown = paths.slice(0, NAMED_PATHS).join(', ');
  const more = paths.length - NAMED_PATHS;
  return more > 0 ? `${shown} and ${String(more)} more` : shown;
}

/** An error's first line, short enough for a note in parentheses. */
function why(error: unknown): string {
  return (
    detailOf(error)
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? 'no reason given'
  );
}

export function createBaseUpdates(ctx: DeliveryContext): BaseUpdates {
  const db = ctx.state.db;

  function notMerged(batch: BatchDto, reason: string, note: string): BaseUpdate {
    ctx.logger.warn(
      { batchId: batch.id, baseBranch: batch.baseBranch, reason },
      'base not merged before the gate',
    );
    return { kind: 'not_merged', note };
  }

  /**
   * The batch now starts from `base`, which its branch holds, and so does each of its tasks that
   * started where the batch did, so their changes read against the base they will merge onto.
   */
  function moveBase(batchId: BatchId, base: string): void {
    ctx.state.write((w) => {
      const old = getBatch(w.tx, batchId).baseSha;
      if (old === base) return;
      patchBatch(w, batchId, { baseSha: base });
      for (const ws of listWorkstreams(w.tx, { batchId }))
        if (old !== null && getWorkstreamRow(w.tx, ws.id).baseHead === old)
          patchWorkstream(w, ws.id, null, { baseHead: base });
    });
  }

  /** The builder's own checkout: counted, never merged into. */
  async function shared(batch: BatchDto, branch: string, from: string): Promise<BaseUpdate> {
    const origin = `origin/${batch.baseBranch}`;
    const project = getProject(db, batch.projectId);
    let behind: number;
    try {
      behind = (await ctx.git.commitsSince(project.repoPath, `refs/heads/${branch}`, from)).length;
    } catch (error) {
      return notMerged(
        batch,
        why(error),
        `10db couldn't compare this branch with ${origin} (${why(error)}), so this gate ran on the branch as it is.`,
      );
    }
    if (behind === 0) return { kind: 'up_to_date' };
    ctx.logger.info(
      { batchId: batch.id, baseBranch: batch.baseBranch, behind },
      'batch branch behind its base in the shared checkout',
    );
    return {
      kind: 'not_merged',
      note: `${origin} has ${String(behind)} commit${behind === 1 ? '' : 's'} this branch doesn't. 10db merges the base only into the worktrees it makes, never into the builder's own checkout, so this gate ran without them: a failure they fix shows here until ${origin} is merged into ${branch}.`,
    };
  }

  /** A worktree 10db made: the base is merged into its branch, and its packages follow the lockfile. */
  async function worktree(
    batch: BatchDto,
    branch: string,
    path: string,
    from: string,
    signal: AbortSignal,
  ): Promise<BaseUpdate> {
    const origin = `origin/${batch.baseBranch}`;
    let merge: BranchMerge;
    try {
      merge = await ctx.git.mergeIntoBranch({
        repo: path,
        branch,
        from,
        message: `Merge ${origin} into ${branch}`,
      });
    } catch (error) {
      return notMerged(
        batch,
        why(error),
        `10db couldn't merge ${origin} into this branch (${why(error)}), so this gate ran without its newer commits.`,
      );
    }
    switch (merge.kind) {
      case 'up_to_date':
        // The builder may have merged it by hand.
        moveBase(batch.id, merge.from);
        return { kind: 'up_to_date' };
      case 'conflict':
        raise(ctx.inbox, batch.projectId, baseCards.conflict(batch, path, merge.paths));
        return notMerged(
          batch,
          `conflict in ${named(merge.paths)}`,
          `${origin} conflicts with this branch in ${named(merge.paths)}, so this gate ran without its newer commits: a failure they fix shows here until the conflict is resolved, which the builder has a card for.`,
        );
      case 'blocked':
        return notMerged(
          batch,
          `uncommitted changes in ${named(merge.paths)}`,
          `Uncommitted changes in ${named(merge.paths)} are in the way of ${origin}'s newer commits, so this gate ran without them.`,
        );
      case 'merged':
        break;
    }
    moveBase(batch.id, merge.from);
    ctx.logger.info(
      {
        batchId: batch.id,
        base: merge.from,
        head: merge.head,
        fastForward: merge.fastForward,
        files: merge.paths.length,
      },
      'base merged into the batch branch',
    );
    if (!merge.paths.includes(PNPM_LOCKFILE))
      return { kind: 'merged', base: merge.from, head: merge.head, note: null };
    const installed = await ctx.dependencies.refresh({
      batch: getBatch(db, batch.id),
      project: getProject(db, batch.projectId),
      path,
      signal,
    });
    switch (installed.kind) {
      case 'aborted':
        return { kind: 'aborted' };
      case 'failed': {
        ctx.logger.warn(
          { batchId: batch.id, exitCode: installed.exitCode, logPath: installed.logPath },
          'worktree dependencies not installed after the base merge',
        );
        const how = installed.timedOut ? 'timed out' : `exit ${String(installed.exitCode)}`;
        return {
          kind: 'merged',
          base: merge.from,
          head: merge.head,
          note: `10db merged ${origin} into this branch, but the install its lockfile needs failed (${how}; log: ${installed.logPath}), so the packages may not match it.`,
        };
      }
      case 'installed':
        ctx.logger.info(
          { batchId: batch.id, logPath: installed.logPath, durationMs: installed.durationMs },
          'worktree dependencies installed',
        );
        break;
      case 'skipped':
        break;
    }
    return { kind: 'merged', base: merge.from, head: merge.head, note: null };
  }

  return {
    async beforeGate(batchId, signal) {
      // A function, so a check after an await is not narrowed away by the one before it.
      const stopped = (): boolean => signal.aborted;
      if (stopped()) return { kind: 'aborted' };
      const batch = getBatch(db, batchId);
      if (batch.branch === null)
        return notMerged(batch, 'no branch', 'The batch has no branch yet, so nothing was merged.');
      const project = getProject(db, batch.projectId);
      // Once per gate, in the project's checkout, whose pin holds the origin the builder trusted; a
      // worktree shares its refs.
      try {
        await ctx.git.fetch(project.repoPath, batch.baseBranch, networkCall(ctx, signal));
      } catch (error) {
        if (stopped()) return { kind: 'aborted' };
        return notMerged(
          batch,
          why(error),
          `10db couldn't fetch ${batch.baseBranch} from origin (${why(error)}), so this gate ran on the branch without any newer commits on ${batch.baseBranch}.`,
        );
      }
      if (stopped()) return { kind: 'aborted' };
      const from = `refs/remotes/origin/${batch.baseBranch}`;
      return batch.worktreePath === null
        ? shared(batch, batch.branch, from)
        : worktree(batch, batch.branch, batch.worktreePath, from, signal);
    },
  };
}
