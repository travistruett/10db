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
import { baseCards, baseConflictKey, baseKeptKey, detailOf } from './cards';
import { networkCall, raise, withdraw, type DeliveryContext } from './context';
import { installedLockfile, recordInstall } from './installed-lockfile';
import { journalDirs, takenNumbers, type TakenNumber } from './migration-numbers';
import { startRef } from './start-refs';
import { PNPM_LOCKFILE, raiseInstallHostCards } from './worktree-dependencies';
import { generatedIn } from './worktree-generated';

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
  /** The fold key of the builder's card about it; null when the task can clear it itself. */
  readonly foldKey: string | null;
}

export interface BeforeGateOptions {
  /**
   * Brings the base in for the task named here, which asked for the migrations hazard, instead of
   * for a gate: no install runs (the next gate's does), a card says the task is held back, and a
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

/** What the install before a gate came to: whether the packages match the lockfile, a note to add, or a stop. */
type Installed =
  | { readonly kind: 'done'; readonly ok: boolean; readonly note: string | null }
  | { readonly kind: 'aborted' };

/** A merge that settled conflicts by itself. */
type SettledMerge = Extract<BranchMerge, { readonly kind: 'merged' }>;

/** Where merging left the branch, and the merge whose generated directories wait for the install. */
interface Merging {
  readonly update: BaseUpdate;
  readonly regenerate: SettledMerge | null;
}

/** What kept a merge's generated directories from being regenerated. */
interface Unregenerated {
  readonly why: string;
  readonly logPath: string | null;
  /** 10db removed what a failed run wrote there. */
  readonly restored: boolean;
}

type Regenerated =
  | { readonly kind: 'done'; readonly head: string; readonly problem: Unregenerated | null }
  | { readonly kind: 'aborted' };

/**
 * Why a generated directory's conflict stays one when a task asks for the migrations hazard: its
 * session is working in the worktree, and its generators would read its uncommitted sources.
 */
const NOT_WHILE_WORKING =
  "it is generated, and 10db regenerates it only at the batch's gate, not while a task's session works in the worktree";

/**
 * A stop between a merge and its regeneration: the next gate finds the branch holding the base and
 * regenerates nothing, so the card is all that says so.
 */
const STOPPED: Unregenerated = {
  why: '10db stopped before it regenerated them',
  logPath: null,
  restored: false,
};

export function createBaseUpdates(ctx: DeliveryContext): BaseUpdates {
  const db = ctx.state.db;

  function notMerged(batch: BatchDto, reason: string, note: string): NotMerged {
    ctx.logger.warn(
      { batchId: batch.id, baseBranch: batch.baseBranch, reason },
      'base not merged before the gate',
    );
    return { kind: 'not_merged', note };
  }

  /** Where merging left the branch, with nothing to regenerate. */
  const alone = (update: BaseUpdate): Merging => ({ update, regenerate: null });

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

  /** What the gate's note says about the conflicts a merge settled; null when it settled none. */
  function settledNote(batch: BatchDto, merged: SettledMerge): string | null {
    const resolved = merged.resolved ?? [];
    if (resolved.length === 0) return null;
    ctx.logger.info(
      { batchId: batch.id, base: merged.from, files: resolved.map((r) => r.path) },
      'base conflicts settled',
    );
    const said = resolved
      .map(
        (r) =>
          `${r.path} (${r.how === 'regenerated' ? 'regenerated from its sources' : "kept both sides' added lines"})`,
      )
      .join(', ');
    return `10db merged origin/${batch.baseBranch} into this branch and settled its conflicts with it: ${said}. The merge commit lists them.`;
  }

  /**
   * Runs the generators of the directories `merged` took from the base and commits what they change
   * there on top of the merge; what the branch had there that the base lacks must come back out of
   * them. The worktree must be clean first: the generators read its sources, and 10db commits only
   * what they make. A failed run's files are removed again.
   */
  async function generate(
    batch: BatchDto,
    project: ProjectDto,
    branch: string,
    path: string,
    merged: SettledMerge,
    signal: AbortSignal,
  ): Promise<Regenerated> {
    const regenerating = merged.regenerate ?? [];
    const dirs = regenerating.map((r) => r.dir);
    const unchanged = (problem: Unregenerated): Regenerated => ({
      kind: 'done',
      head: merged.head,
      problem,
    });
    const dirty = await ctx.git.changedPaths(path);
    if (dirty.length > 0)
      return unchanged({
        why: `the worktree has uncommitted changes the generators would read (${named(dirty)})`,
        logPath: null,
        restored: false,
      });
    const generated = await ctx.generators.regenerate({ batch, project, path, dirs, signal });
    if (generated.kind === 'aborted') {
      // What a stopped run wrote would be in the next merge's way.
      await ctx.git.restoreDirs(path, dirs).catch(() => []);
      return { kind: 'aborted' };
    }
    if (generated.kind === 'failed') {
      const how = generated.timedOut ? 'timed out' : `exit ${String(generated.exitCode)}`;
      const restored = (await ctx.git.restoreDirs(path, dirs)).length > 0;
      return unchanged({
        why: `regenerating them failed (${how})`,
        logPath: generated.logPath,
        restored,
      });
    }
    const changed = (await ctx.git.changedPaths(path)).filter((file) =>
      dirs.some((dir) => file.startsWith(dir)),
    );
    let head = merged.head;
    if (changed.length > 0) {
      await ctx.git.commit({
        repo: path,
        paths: changed,
        message: `Regenerate ${dirs.join(', ')} after merging origin/${batch.baseBranch}`,
        opId: `regenerate-${merged.head}`,
        branch,
      });
      head = await ctx.git.head(path);
    }
    const done = (problem: Unregenerated | null): Regenerated => ({ kind: 'done', head, problem });
    // Each directory conflicted, so the branch's version of it differs from the base's, which the
    // merge took: one the generators left as it was has lost the branch's changes there.
    const same = dirs.filter((dir) => !changed.some((file) => file.startsWith(dir)));
    if (same.length > 0)
      return done({
        why: `regenerating changed nothing in ${named(same)}, so the batch's own changes there are gone from it`,
        logPath: generated.logPath,
        restored: false,
      });
    // A migration the branch made that the generator didn't make again is lost from the branch's
    // tree: a hand-written one, or one the sources no longer produce.
    const made = new Set<string>();
    for (const file of changed.filter((f) => f.endsWith('.sql'))) {
      const oid = await ctx.git.blobAt(path, 'HEAD', file);
      if (oid !== null) made.add(oid);
    }
    const missing: string[] = [];
    for (const file of regenerating.flatMap((r) => r.dropped).filter((f) => f.endsWith('.sql'))) {
      const was = await ctx.git.blobAt(path, `${merged.head}^1`, file);
      const is = await ctx.git.blobAt(path, 'HEAD', file);
      if (was !== null && was !== is && !made.has(was)) missing.push(file);
    }
    if (missing.length === 0) return done(null);
    return done({
      why: `${named(missing)} from the batch's branch ${missing.length === 1 ? 'is' : 'are'} gone from it, and regenerating did not make ${missing.length === 1 ? 'it' : 'them'} again`,
      logPath: generated.logPath,
      restored: false,
    });
  }

  /**
   * Regenerates the generated directories a merge took from the base, after the install the merged
   * lockfile needs: run before it, an older generator would write the files, or the run would fail.
   * What kept them from it is one card. Never throws. Resolves with the branch's head and the note to
   * add, or with a stop.
   */
  async function regenerate(
    batch: BatchDto,
    project: ProjectDto,
    branch: string,
    path: string,
    merged: SettledMerge,
    installed: boolean,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: 'done'; readonly head: string; readonly note: string | null }
    | { readonly kind: 'aborted' }
  > {
    const dirs = (merged.regenerate ?? []).map((r) => r.dir);
    let outcome: Regenerated;
    try {
      outcome = installed
        ? await generate(batch, project, branch, path, merged, signal)
        : {
            kind: 'done',
            head: merged.head,
            problem: {
              why: "the install the merged lockfile needs failed, so 10db didn't run the generators",
              logPath: null,
              restored: false,
            },
          };
    } catch (error) {
      const restored = await ctx.git.restoreDirs(path, dirs).then(
        (paths) => paths.length > 0,
        () => false,
      );
      outcome = signal.aborted
        ? { kind: 'aborted' }
        : {
            kind: 'done',
            head: await ctx.git.head(path).catch(() => merged.head),
            problem: {
              why: `10db couldn't run the generators (${why(error)})`,
              logPath: null,
              restored,
            },
          };
    }
    if (outcome.kind === 'aborted') {
      unregenerated(batch, path, merged, STOPPED);
      return outcome;
    }
    const { head, problem } = outcome;
    if (problem === null) return { kind: 'done', head, note: null };
    return { kind: 'done', head, note: unregenerated(batch, path, merged, problem) };
  }

  /**
   * Tells the builder, on one card, what kept the generated directories `merged` took from the base
   * from being regenerated. Resolves with what the gate's note says of it.
   */
  function unregenerated(
    batch: BatchDto,
    path: string,
    merged: SettledMerge,
    problem: Unregenerated,
  ): string {
    const dirs = (merged.regenerate ?? []).map((r) => r.dir);
    ctx.logger.warn(
      { batchId: batch.id, dirs, reason: problem.why, logPath: problem.logPath },
      'generated files not regenerated after the base merged',
    );
    tell(batch, () => {
      raise(ctx.inbox, batch.projectId, baseCards.regenerate(batch, path, dirs, problem));
    });
    return `10db couldn't regenerate ${named(dirs)} after merging origin/${batch.baseBranch}: ${problem.why}. This gate may see generated files that don't match their sources; the builder has a card.`;
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

  /**
   * A worktree 10db made: the base is merged into its branch. The generated directories a settled
   * merge took from the base are left to regenerate after the install (`regenerate`).
   */
  async function merge(
    batch: BatchDto,
    branch: string,
    path: string,
    from: string,
    options: BeforeGateOptions,
  ): Promise<Merging> {
    const migrationsFor = options.forMigrations?.task;
    const context = migrationsFor === undefined ? {} : { migrationsFor };
    const holding = (held: BaseHeld) => (migrationsFor === undefined ? {} : { held });
    const origin = `origin/${batch.baseBranch}`;
    let merged: BranchMerge;
    try {
      // Only the directories the project's own packages make, on the branch and on the base: in any
      // other project the same paths are just files.
      const generated = await generatedIn(ctx.git, path, [`refs/heads/${branch}`, from]);
      merged = await ctx.git.mergeIntoBranch({
        repo: path,
        branch,
        from,
        message: `Merge ${origin} into ${branch}`,
        resolve:
          migrationsFor === undefined
            ? { generated }
            : { generated, generatedHeld: NOT_WHILE_WORKING },
      });
    } catch (error) {
      return alone(
        notMerged(
          batch,
          why(error),
          `10db couldn't merge ${origin} into this branch (${why(error)}), so this gate ran without its newer commits.`,
        ),
      );
    }
    switch (merged.kind) {
      case 'conflict': {
        const { paths } = merged;
        const reasons = new Map((merged.unresolved ?? []).map((u) => [u.path, u.reason]));
        // Read every conflicted path, not only the ones 10db left: a journal it would have settled by
        // taking the base's directory still shows the migration the branch must renumber.
        const taken = await takenIn(path, merged.from, merged.conflicted ?? paths);
        tell(batch, () => {
          raise(
            ctx.inbox,
            batch.projectId,
            baseCards.conflict(batch, path, paths, { ...context, taken, reasons }),
          );
        });
        return alone({
          ...notMerged(
            batch,
            `conflict in ${named(paths)}`,
            `${origin} conflicts with this branch in ${named(paths)}, so this gate ran without its newer commits: a failure they fix shows here until the conflict is resolved, which the builder has a card for.`,
          ),
          ...holding({ reason: 'conflict', paths, foldKey: baseConflictKey(batch.id) }),
        });
      }
      case 'blocked': {
        const { changed, kept } = merged;
        if (kept.length > 0)
          tell(batch, () => {
            raise(ctx.inbox, batch.projectId, baseCards.kept(batch, path, kept, context));
          });
        return alone({
          ...notMerged(
            batch,
            `in the way: ${named([...changed, ...kept])}`,
            joined(
              changed.length === 0
                ? null
                : `Uncommitted changes in ${named(changed)} are in the way of ${origin}'s newer commits, so this gate ran without them.`,
              kept.length === 0
                ? null
                : `10db didn't merge ${origin} because files in the worktree that git doesn't track are in the way (${named(kept)}). Don't remove or move them: they may be the builder's, and the builder has a card about them. This gate ran without ${origin}'s newer commits.`,
            ) ??
              `Files are in the way of ${origin}'s newer commits, so this gate ran without them.`,
          ),
          // The builder's files outrank the task's own: only the builder can move them.
          ...holding(
            kept.length > 0
              ? { reason: 'untracked', paths: kept, foldKey: baseKeptKey(batch.id) }
              : { reason: 'uncommitted', paths: changed, foldKey: null },
          ),
        });
      }
      case 'up_to_date':
      case 'merged':
        break;
    }
    // The branch holds the base, the builder's own hand merge included: nothing is in its way.
    tell(batch, () => {
      withdraw(ctx.state, ctx.inbox, batch.projectId, [
        baseConflictKey(batch.id),
        baseKeptKey(batch.id),
      ]);
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
    if (merged.kind === 'up_to_date') return alone({ kind: 'up_to_date', note: unmoved });
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
    return {
      update: {
        kind: 'merged',
        base: merged.from,
        head: merged.head,
        note: joined(settledNote(batch, merged), unmoved),
      },
      regenerate: (merged.regenerate ?? []).length > 0 ? merged : null,
    };
  }

  /**
   * Installs again when the lockfile at the worktree's HEAD is not the one its packages were last
   * installed from: a merge or a hand merge changed it, or the last install failed or was stopped.
   * Resolves with whether the packages now match it and the note to add, or with a stop.
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
        return { kind: 'done', ok: true, note: null };
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
            ok: false,
            note: `The install this branch's lockfile needs failed (${how}; log: ${installed.logPath}), so its packages may not match it.${blocked}`,
          };
        }
        case 'installed':
          ctx.logger.info(
            { batchId: batch.id, logPath: installed.logPath, durationMs: installed.durationMs },
            'worktree dependencies installed',
          );
          return { kind: 'done', ok: true, note: null };
        case 'skipped':
          return { kind: 'done', ok: true, note: null };
      }
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted' };
      ctx.logger.warn({ batchId: batch.id, err: why(error) }, 'worktree install not run');
      return {
        kind: 'done',
        ok: false,
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
    let merging: Merging | null = null;
    // Once per gate, in the project's checkout, whose pin holds the origin the builder trusted; a
    // worktree shares its refs.
    try {
      await ctx.git.fetch(project.repoPath, batch.baseBranch, networkCall(ctx, signal));
    } catch (error) {
      if (stopped()) return { kind: 'aborted' };
      merging = alone(
        notMerged(
          batch,
          why(error),
          `10db couldn't fetch ${batch.baseBranch} from origin (${why(error)}), so this gate ran on the branch without any newer commits on ${batch.baseBranch}.`,
        ),
      );
    }
    if (stopped()) return { kind: 'aborted' };
    merging ??=
      batch.worktreePath === null
        ? alone(await shared(batch, batch.branch, from))
        : await merge(batch, batch.branch, batch.worktreePath, from, options);
    const merged = merging.update;
    const path = batch.worktreePath;
    const pending = merging.regenerate;
    const stop = (): BaseUpdate => {
      if (pending !== null && path !== null) unregenerated(batch, path, pending, STOPPED);
      return { kind: 'aborted' };
    };
    if (merged.kind === 'aborted' || stopped()) return stop();
    // Asked for the migrations hazard, the task's session waits on it: the next gate installs. Its
    // merge settled no generated directory (`NOT_WHILE_WORKING`), so none waits to be regenerated.
    if (path === null || options.forMigrations) return merged;
    const installed = await install(batch, project, path, signal);
    if (installed.kind === 'aborted' || stopped()) return stop();
    switch (merged.kind) {
      case 'not_merged':
        return { kind: 'not_merged', note: joined(merged.note, installed.note) ?? merged.note };
      case 'up_to_date':
        return { ...merged, note: joined(merged.note, installed.note) };
      case 'merged': {
        if (pending === null) return { ...merged, note: joined(merged.note, installed.note) };
        // Its own stop says so on the card; once it has run, a stop leaves nothing undone.
        const regenerated = await regenerate(
          batch,
          project,
          batch.branch,
          path,
          pending,
          installed.ok,
          signal,
        );
        if (regenerated.kind === 'aborted' || stopped()) return { kind: 'aborted' };
        return {
          ...merged,
          head: regenerated.head,
          note: joined(merged.note, regenerated.note, installed.note),
        };
      }
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
