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
import { detailOf } from './cards';
import { hideNotices, networkCall, showNotice, type DeliveryContext } from './context';
import { installedLockfile, recordInstall } from './installed-lockfile';
import { journalDirs, takenNumbers, type TakenNumber } from './migration-numbers';
import { baseNotices, NOTICE_KEY } from './notices';
import { startRef } from './start-refs';
import { PNPM_LOCKFILE, raiseInstallHostCards } from './worktree-dependencies';

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
  /**
   * The gate tests the branch as it is; `note` says why. `held`, asked for the migrations hazard
   * only, says what in the branch kept the base out.
   */
  | { readonly kind: 'not_merged'; readonly note: string; readonly held?: BaseHeld }
  /** Shutdown or a cancel stopped it: no gate runs. */
  | { readonly kind: 'aborted' };

/** What in a worktree batch's branch kept its base out. */
export interface BaseHeld {
  /** Both sides changed `paths`; uncommitted changes, or files git doesn't track, are in the way. */
  readonly reason: 'conflict' | 'uncommitted' | 'untracked';
  readonly paths: readonly string[];
}

export interface BeforeGateOptions {
  /**
   * Brings the base in for the task named here, which asked for the migrations hazard, instead of
   * for a gate: no install runs (the next gate's does), a notice says the task is held back, and a
   * branch that can't take the base says why in `held`.
   */
  readonly forMigrations?: { readonly task: string };
}

export interface BaseUpdates {
  /**
   * Fetches the batch's base branch, then brings it into a worktree batch's branch so its gate tests
   * what the pull request would merge, and installs again when the worktree's packages don't match
   * its lockfile. A batch in the builder's own checkout is never merged into: it is only told how far
   * behind its base it is. A gate runs it as its `beforeStart`, inside `gate`, so no other gate's merge
   * changes the tree under it. Never throws: whatever kept the base or the install out is the note.
   */
  beforeGate(
    batchId: BatchId,
    signal: AbortSignal,
    options?: BeforeGateOptions,
  ): Promise<BaseUpdate>;
  /**
   * Runs `run`, one gate of the batch's at a time: a batch's gates share its checkout, so one gate's
   * base update must wait until the gate before it has finished, whatever the number of gate slots.
   * Gates of other batches don't wait. Resolves null, without running `run`, when `signal` aborts
   * before its turn; the gates behind it keep their order.
   */
  gate<T>(batchId: BatchId, signal: AbortSignal, run: () => Promise<T>): Promise<T | null>;
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

type NotMerged = Extract<BaseUpdate, { readonly kind: 'not_merged' }>;

/** Where drizzle-kit keeps a migration directory's journal, relative to the directory. */
const JOURNAL_PATH = 'meta/_journal.json';

/** A journal past this is not one drizzle-kit wrote for a project's migrations: it is not read. */
const JOURNAL_MAX_BYTES = 1024 * 1024;

/** What the install before a gate came to: a note to add, or a stop. */
type Installed =
  { readonly kind: 'done'; readonly note: string | null } | { readonly kind: 'aborted' };

export function createBaseUpdates(ctx: DeliveryContext): BaseUpdates {
  const db = ctx.state.db;

  function notMerged(batch: BatchDto, reason: string, note: string): NotMerged {
    ctx.logger.warn(
      { batchId: batch.id, baseBranch: batch.baseBranch, reason },
      'base not merged before the gate',
    );
    return { kind: 'not_merged', note };
  }

  /** Shows or clears a notice without letting the database stop the gate. */
  function tell(batch: BatchDto, act: () => void): void {
    try {
      act();
    } catch (error) {
      ctx.logger.warn({ batchId: batch.id, err: why(error) }, 'base notice not updated');
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
        ref: startRef(ctx.worktreeRoot, id),
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

  /**
   * The branch's migrations whose number the base already gives another, in the drizzle journals
   * that conflict. Read from the commits, so nothing in the worktree changes; none when they can't be read.
   */
  async function takenIn(path: string, base: string, paths: readonly string[]) {
    const taken: TakenNumber[] = [];
    for (const dir of journalDirs(paths)) {
      const journal = dir === '.' ? JOURNAL_PATH : `${dir}/${JOURNAL_PATH}`;
      try {
        const [ours, theirs] = await Promise.all(
          ['HEAD', base].map(async (rev) => {
            const found = await ctx.git.fileAt(path, rev, journal, JOURNAL_MAX_BYTES);
            return found.kind === 'file' ? found.text : null;
          }),
        );
        taken.push(...takenNumbers(dir, ours ?? null, theirs ?? null));
      } catch (error) {
        ctx.logger.warn({ path, journal, err: why(error) }, 'migration journal not read');
      }
    }
    return taken;
  }

  /** A worktree 10db made: the base is merged into its branch. */
  async function merge(
    batch: BatchDto,
    branch: string,
    path: string,
    from: string,
    options: BeforeGateOptions,
  ): Promise<Merged> {
    const migrationsFor = options.forMigrations?.task;
    const context = migrationsFor === undefined ? {} : { migrationsFor };
    const holding = (held: BaseHeld) => (migrationsFor === undefined ? {} : { held });
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
        const taken = await takenIn(path, merged.from, paths);
        // The batch's tasks show it; no card asks the builder anything about a conflict that stands.
        tell(batch, () => {
          showNotice(
            ctx.state,
            batch.id,
            baseNotices.conflict(batch, path, paths, { ...context, taken }),
          );
        });
        return {
          ...notMerged(
            batch,
            `conflict in ${named(paths)}`,
            `${origin} conflicts with this branch in ${named(paths)}, so this gate ran without its newer commits: a failure they fix shows here until the conflict is resolved, which the batch's tasks show.`,
          ),
          ...holding({ reason: 'conflict', paths }),
        };
      }
      case 'blocked': {
        const { changed, kept } = merged;
        if (kept.length > 0)
          tell(batch, () => {
            showNotice(ctx.state, batch.id, baseNotices.kept(batch, path, kept, context));
          });
        return {
          ...notMerged(
            batch,
            `in the way: ${named([...changed, ...kept])}`,
            joined(
              changed.length === 0
                ? null
                : `Uncommitted changes in ${named(changed)} are in the way of ${origin}'s newer commits, so this gate ran without them.`,
              kept.length === 0
                ? null
                : `10db didn't merge ${origin} because files in the worktree that git doesn't track are in the way (${named(kept)}). Don't remove or move them: they may be the builder's, and the batch's tasks show them. This gate ran without ${origin}'s newer commits.`,
            ) ??
              `Files are in the way of ${origin}'s newer commits, so this gate ran without them.`,
          ),
          // The builder's files outrank the task's own: only the builder can move them.
          ...holding(
            kept.length > 0
              ? { reason: 'untracked', paths: kept }
              : { reason: 'uncommitted', paths: changed },
          ),
        };
      }
      case 'up_to_date':
      case 'merged':
        break;
    }
    // The branch holds the base, the builder's own hand merge included: nothing is in its way.
    tell(batch, () => {
      hideNotices(ctx.state, batch.id, [NOTICE_KEY.baseConflict, NOTICE_KEY.baseKept]);
    });
    let unmoved: string | null = null;
    try {
      await moveBase(batch, path, merged.from);
    } catch (error) {
      ctx.logger.warn({ batchId: batch.id, err: why(error) }, 'batch base not moved');
      const held =
        merged.kind === 'merged'
          ? `10db merged ${origin} into this branch`
          : `This branch already holds ${origin}`;
      unmoved = `${held} but couldn't move the batch's base to it (${why(error)}), so this task's changes may still count ${origin}'s as its own.`;
    }
    if (merged.kind === 'up_to_date') return { kind: 'up_to_date', note: unmoved };
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
    return { kind: 'merged', base: merged.from, head: merged.head, note: unmoved };
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
            {
              batchId: batch.id,
              exitCode: installed.exitCode,
              logPath: installed.logPath,
              blockedHosts: installed.blockedHosts,
            },
            'worktree dependencies not installed before the gate',
          );
          tell(batch, () => {
            raiseInstallHostCards(ctx, project.id, installed);
          });
          const how = installed.timedOut ? 'timed out' : `exit ${String(installed.exitCode)}`;
          const blocked =
            installed.blockedHosts.length === 0
              ? ''
              : ` The sandbox blocked it from reaching ${named(installed.blockedHosts)}.`;
          return {
            kind: 'done',
            note: `The install this branch's lockfile needs failed (${how}; log: ${installed.logPath}), so its packages may not match it.${blocked}`,
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

  async function update(
    batchId: BatchId,
    signal: AbortSignal,
    options: BeforeGateOptions,
  ): Promise<BaseUpdate> {
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
        : await merge(batch, batch.branch, batch.worktreePath, from, options);
    // Asked for the migrations hazard, the task's session waits on it: the next gate installs.
    if (batch.worktreePath === null || options.forMigrations) return merged;
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

  /** Each batch's latest gate, which the next one waits for. */
  const gates = new Map<BatchId, Promise<unknown>>();

  return {
    gate<T>(batchId: BatchId, signal: AbortSignal, run: () => Promise<T>): Promise<T | null> {
      const ahead = gates.get(batchId) ?? Promise.resolve();
      const turn = new Promise<boolean>((resolve) => {
        if (signal.aborted) {
          resolve(false);
          return;
        }
        const onAbort = (): void => {
          resolve(false);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void ahead.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve(true);
        });
      });
      const next = turn.then((go) => (go ? run() : null));
      // The next gate waits for the one ahead too: a gate stopped while waiting holds no turn.
      const settled = Promise.all([ahead, next]).then(
        () => undefined,
        () => undefined,
      );
      gates.set(batchId, settled);
      // The last gate of a batch to settle forgets it, so finished batches hold no entry.
      void settled.then(() => {
        if (gates.get(batchId) === settled) gates.delete(batchId);
      });
      return next;
    },
    async beforeGate(batchId, signal, options = {}) {
      // A function, so the check in the catch below is not narrowed away by the one before it.
      const stopped = (): boolean => signal.aborted;
      if (stopped()) return { kind: 'aborted' };
      try {
        return await update(batchId, signal, options);
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
