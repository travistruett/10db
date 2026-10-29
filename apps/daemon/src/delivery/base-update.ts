import type { BatchDto, BatchId, ProjectDto, WorkstreamId } from '@10db/contracts';
import {
  getBatch,
  getProject,
  getWorkstreamRow,
  listWorkstreams,
  patchBatch,
  patchWorkstream,
} from '@10db/db';
import type { BranchMerge } from '../git';
import { baseCards, baseConflictKey, detailOf } from './cards';
import { networkCall, raise, withdraw, type DeliveryContext } from './context';
import { installedLockfile, recordInstall } from './installed-lockfile';
import { PNPM_LOCKFILE } from './worktree-dependencies';

/** What happened to a batch's branch before its gate (`decisions/2026-10-29-gate-with-base.md`). */
export type BaseUpdate =
  /** The branch holds its base as origin has it now. */
  | { readonly kind: 'up_to_date'; readonly note: string | null }
  /** The base was merged into the worktree batch's branch, now at `head`; the batch's base is `base`. */
  | {
      readonly kind: 'merged';
      readonly base: string;
      readonly head: string;
      readonly note: string | null;
    }
  /** The gate tests the branch as it is; `note` says why. */
  | { readonly kind: 'not_merged'; readonly note: string }
  /** Shutdown or a cancel stopped it: no gate runs. */
  | { readonly kind: 'aborted' };

export interface BaseUpdates {
  /**
   * Fetches the batch's base branch, then brings it into a worktree batch's branch so its gate tests
   * what the pull request would merge, and installs again when the worktree's packages don't match
   * its lockfile. A batch in the builder's own checkout is never merged into: it is only told how far
   * behind its base it is. The gate runs it once it holds its slot, so no other gate's merge changes
   * the tree under it. Never throws: whatever kept the base or the install out is the note.
   */
  beforeGate(batchId: BatchId, signal: AbortSignal): Promise<BaseUpdate>;
}

/** What a gate's evidence or card says about its base and packages; null when there is nothing. */
export function gateNote(update: BaseUpdate): string | null {
  switch (update.kind) {
    case 'up_to_date':
    case 'merged':
    case 'not_merged':
      return update.note;
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

/** `notes` that say something, as one note; null when none does. */
function joined(...notes: readonly (string | null)[]): string | null {
  const said = notes.filter((note): note is string => note !== null);
  return said.length === 0 ? null : said.join('\n\n');
}

/** Where the merge left the branch, before the install has its say. */
type Merged = Exclude<BaseUpdate, { readonly kind: 'aborted' }>;

/** What the install before a gate came to: a note to add, or a stop. */
type Installed =
  { readonly kind: 'done'; readonly note: string | null } | { readonly kind: 'aborted' };

export function createBaseUpdates(ctx: DeliveryContext): BaseUpdates {
  const db = ctx.state.db;

  function notMerged(batch: BatchDto, reason: string, note: string): Merged {
    ctx.logger.warn(
      { batchId: batch.id, baseBranch: batch.baseBranch, reason },
      'base not merged before the gate',
    );
    return { kind: 'not_merged', note };
  }

  /** Raises or withdraws a card without letting the inbox stop the gate. */
  function tell(batch: BatchDto, act: () => void): void {
    try {
      act();
    } catch (error) {
      ctx.logger.warn({ batchId: batch.id, err: why(error) }, 'base card not updated');
    }
  }

  /**
   * Where a task that started at `start` would have started on `base`: the base itself for one that
   * started where the batch did, else the merge of its start with `base`, kept reachable at a 10db
   * ref. Null when that merge conflicts or git refuses it; the task then keeps its start.
   */
  async function startOnBase(
    path: string,
    id: WorkstreamId,
    start: string,
    old: string | null,
    base: string,
  ): Promise<string | null> {
    if (start === old) return base;
    return ctx.git
      .mergedCommit({
        repo: path,
        ours: start,
        theirs: base,
        ref: `refs/10db/starts/${id}`,
        message: `10db: where ${id} starts on ${base}`,
      })
      .catch(() => null);
  }

  /**
   * The batch now starts from `base`, which its branch holds, and so does each of its tasks, so their
   * changes read against the base they will merge onto. Only ever forward: a base branch forced back
   * or sideways leaves both where they were.
   */
  async function moveBase(batch: BatchDto, path: string, base: string): Promise<void> {
    const old = getBatch(db, batch.id).baseSha;
    if (old === base) return;
    if (old !== null && !(await ctx.git.isAncestor(path, old, base))) {
      ctx.logger.info({ batchId: batch.id, old, base }, 'batch base not moved back');
      return;
    }
    const starts = new Map<WorkstreamId, { from: string; to: string }>();
    for (const ws of listWorkstreams(db, { batchId: batch.id })) {
      const start = getWorkstreamRow(db, ws.id).baseHead;
      if (start === null || start === base) continue;
      const to = await startOnBase(path, ws.id, start, old, base);
      if (to === null) {
        ctx.logger.warn(
          { batchId: batch.id, workstreamId: ws.id },
          "task start not moved to the merged base: its changes include the base's",
        );
        continue;
      }
      starts.set(ws.id, { from: start, to });
    }
    ctx.state.write((w) => {
      patchBatch(w, batch.id, { baseSha: base });
      for (const [id, { from, to }] of starts)
        if (getWorkstreamRow(w.tx, id).baseHead === from)
          patchWorkstream(w, id, null, { baseHead: to });
    });
  }

  /** The builder's own checkout: counted, never merged into. */
  async function shared(batch: BatchDto, branch: string, from: string): Promise<Merged> {
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
    if (behind === 0) return { kind: 'up_to_date', note: null };
    ctx.logger.info(
      { batchId: batch.id, baseBranch: batch.baseBranch, behind },
      'batch branch behind its base in the shared checkout',
    );
    return {
      kind: 'not_merged',
      note: `${origin} has ${String(behind)} commit${behind === 1 ? '' : 's'} this branch doesn't. 10db merges the base only into the worktrees it makes, never into the builder's own checkout, so this gate ran without them: a failure they fix shows here until ${origin} is merged into ${branch}.`,
    };
  }

  /** A worktree 10db made: the base is merged into its branch. */
  async function merge(
    batch: BatchDto,
    branch: string,
    path: string,
    from: string,
  ): Promise<Merged> {
    const origin = `origin/${batch.baseBranch}`;
    let merged: BranchMerge;
    try {
      merged = await ctx.git.mergeIntoBranch({
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
    switch (merged.kind) {
      case 'conflict': {
        const { paths } = merged;
        tell(batch, () => {
          raise(ctx.inbox, batch.projectId, baseCards.conflict(batch, path, paths));
        });
        return notMerged(
          batch,
          `conflict in ${named(paths)}`,
          `${origin} conflicts with this branch in ${named(paths)}, so this gate ran without its newer commits: a failure they fix shows here until the conflict is resolved, which the builder has a card for.`,
        );
      }
      case 'blocked':
        return notMerged(
          batch,
          `in the way: ${named(merged.paths)}`,
          `Uncommitted or ignored files are in the way of ${origin}'s newer commits (${named(merged.paths)}), so this gate ran without them.`,
        );
      case 'up_to_date':
      case 'merged':
        break;
    }
    // The branch holds the base, the builder's own hand merge included: any conflict is over.
    await moveBase(batch, path, merged.from);
    tell(batch, () => {
      withdraw(ctx.state, ctx.inbox, batch.projectId, [baseConflictKey(batch.id)]);
    });
    if (merged.kind === 'up_to_date') return { kind: 'up_to_date', note: null };
    ctx.logger.info(
      {
        batchId: batch.id,
        base: merged.from,
        head: merged.head,
        fastForward: merged.fastForward,
        files: merged.paths.length,
      },
      'base merged into the batch branch',
    );
    return { kind: 'merged', base: merged.from, head: merged.head, note: null };
  }

  /**
   * Installs again when the lockfile at the worktree's HEAD is not the one its packages were last
   * installed from: a merge or a hand merge changed it, or the last install failed or was stopped.
   * Resolves with the note to add, or with a stop.
   */
  async function install(
    batch: BatchDto,
    project: ProjectDto,
    path: string,
    signal: AbortSignal,
  ): Promise<Installed> {
    try {
      const lockfile = await ctx.git.blobAt(path, 'HEAD', PNPM_LOCKFILE);
      if (lockfile === null || lockfile === installedLockfile(db, batch.id))
        return { kind: 'done', note: null };
      const installed = await ctx.dependencies.refresh({
        batch: getBatch(db, batch.id),
        project,
        path,
        signal,
      });
      await recordInstall(ctx, batch.id, path, installed);
      switch (installed.kind) {
        case 'aborted':
          return { kind: 'aborted' };
        case 'failed': {
          ctx.logger.warn(
            { batchId: batch.id, exitCode: installed.exitCode, logPath: installed.logPath },
            'worktree dependencies not installed before the gate',
          );
          const how = installed.timedOut ? 'timed out' : `exit ${String(installed.exitCode)}`;
          return {
            kind: 'done',
            note: `The install this branch's lockfile needs failed (${how}; log: ${installed.logPath}), so its packages may not match it.`,
          };
        }
        case 'installed':
          ctx.logger.info(
            { batchId: batch.id, logPath: installed.logPath, durationMs: installed.durationMs },
            'worktree dependencies installed',
          );
          return { kind: 'done', note: null };
        case 'skipped':
          return { kind: 'done', note: null };
      }
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted' };
      ctx.logger.warn({ batchId: batch.id, err: why(error) }, 'worktree install not run');
      return {
        kind: 'done',
        note: `10db couldn't run the install this branch's lockfile needs (${why(error)}), so its packages may not match it.`,
      };
    }
  }

  async function update(batchId: BatchId, signal: AbortSignal): Promise<BaseUpdate> {
    // A function, so a check after an await is not narrowed away by the one before it.
    const stopped = (): boolean => signal.aborted;
    const batch = getBatch(db, batchId);
    if (batch.branch === null)
      return notMerged(batch, 'no branch', 'The batch has no branch yet, so nothing was merged.');
    const project = getProject(db, batch.projectId);
    const from = `refs/remotes/origin/${batch.baseBranch}`;
    let merged: Merged | null = null;
    // Once per gate, in the project's checkout, whose pin holds the origin the builder trusted; a
    // worktree shares its refs.
    try {
      await ctx.git.fetch(project.repoPath, batch.baseBranch, networkCall(ctx, signal));
    } catch (error) {
      if (stopped()) return { kind: 'aborted' };
      merged = notMerged(
        batch,
        why(error),
        `10db couldn't fetch ${batch.baseBranch} from origin (${why(error)}), so this gate ran on the branch without any newer commits on ${batch.baseBranch}.`,
      );
    }
    if (stopped()) return { kind: 'aborted' };
    merged ??=
      batch.worktreePath === null
        ? await shared(batch, batch.branch, from)
        : await merge(batch, batch.branch, batch.worktreePath, from);
    if (batch.worktreePath === null) return merged;
    const installed = await install(batch, project, batch.worktreePath, signal);
    if (installed.kind === 'aborted' || stopped()) return { kind: 'aborted' };
    switch (merged.kind) {
      case 'not_merged':
        return { kind: 'not_merged', note: joined(merged.note, installed.note) ?? merged.note };
      case 'up_to_date':
      case 'merged':
        return { ...merged, note: joined(merged.note, installed.note) };
    }
  }

  return {
    async beforeGate(batchId, signal) {
      // A function, so the check in the catch below is not narrowed away by the one before it.
      const stopped = (): boolean => signal.aborted;
      if (stopped()) return { kind: 'aborted' };
      try {
        return await update(batchId, signal);
      } catch (error) {
        if (stopped()) return { kind: 'aborted' };
        ctx.logger.warn({ batchId, err: why(error) }, 'base not merged before the gate');
        return {
          kind: 'not_merged',
          note: `10db couldn't bring the base into this branch (${why(error)}), so this gate ran on it as it is.`,
        };
      }
    },
  };
}
