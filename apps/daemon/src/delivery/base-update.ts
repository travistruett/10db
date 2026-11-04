import type { BatchDto, BatchId, ProjectDto, WorkstreamId } from '@10db/contracts';
import {
  getBatch,
  getProject,
  getWorkstreamRow,
  listWorkstreams,
  patchBatch,
  patchWorkstream,
} from '@10db/db';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BranchMerge, ResolvedConflict } from '../git';
import { baseCards, baseConflictKey, baseKeptKey, detailOf } from './cards';
import {
  hideNotices,
  networkCall,
  raise,
  showNotice,
  withdraw,
  type DeliveryContext,
} from './context';
import { checkInstall, describeBroken } from './install-health';
import { installedLockfile, recordInstall } from './installed-lockfile';
import { journalDirs, takenNumbers, type TakenNumber } from './migration-numbers';
import { baseNotices, installNotices, NOTICE_KEY } from './notices';
import { mergeRef, startRef } from './start-refs';
import { PNPM_LOCKFILE, raiseInstallHostCards } from './worktree-dependencies';
import { generatedIn } from './worktree-generated';

/**
 * What 10db keeps (`Git.keepNote`, at `mergeRef`) while a base merge's conflict markers wait for a
 * session: the merge commit, the base it brought in, the files with markers, and the generated
 * directories to regenerate once the sources they come from are resolved. It is JSON read back from
 * the git dir, so it is parsed.
 */
const PendingMerge = z.object({
  from: z.string().min(1),
  head: z.string().min(1),
  marked: z.array(z.string().min(1)).min(1),
  regenerate: z.array(z.object({ dir: z.string().min(1), dropped: z.array(z.string()) })),
});
type PendingMerge = z.infer<typeof PendingMerge>;

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
      /** The conflicts the merge settled; only when asked for a pull request (`forPullRequest`). */
      readonly resolved?: readonly ResolvedConflict[];
    }
  /**
   * The gate tests the branch as it is; `note` says why. `held`, asked for the migrations hazard or
   * for a pull request only, says what in the branch kept the base out.
   */
  | { readonly kind: 'not_merged'; readonly note: string; readonly held?: BaseHeld }
  /**
   * The base is merged into the branch, but git's conflict markers are still in `paths`: no gate
   * runs, because it would test a branch that cannot build. A session resolves them and commits;
   * the next gate finds them gone (`decisions/2026-11-01-a-session-resolves-the-conflicts-of-the-base-merge.md`).
   */
  | {
      readonly kind: 'conflicted';
      readonly base: string;
      readonly paths: readonly string[];
      readonly note: string;
      /**
       * Set when this gate made the merge that left the markers, so no session has seen them; absent
       * when it found markers an earlier gate's merge left. The runner words its failure by it.
       */
      readonly fresh?: true;
    }
  /**
   * The copy's packages do not match its lockfile even after the install ran again: some dependency
   * the lockfile names does not resolve, so the gate's tools could not start. No gate runs, and the
   * task's code is not at fault: the runner does not count an attempt
   * (`decisions/2026-11-03-a-broken-install-is-not-a-failed-gate.md`). Asked for a pull request, it
   * is answered only for a merge this update made: with none there is nothing to stop, and the
   * answer is what the branch holds.
   */
  | {
      readonly kind: 'install_broken';
      readonly note: string;
      /**
       * The head the merge wrote, before the install, when this update made one (generated
       * directories waiting for a regeneration that did not run are in it as the base had them). A
       * caller that does not push puts the branch back from it.
       */
      readonly head?: string;
      /** The generated directories the merge took from the base, which no regeneration made again. */
      readonly unregenerated?: readonly string[];
    }
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
  /**
   * Brings the base into the branch of a batch whose pull request is open and conflicts with it
   * (`ship.ts` catches it up). The merge runs the install and the generators as a gate's does. A
   * branch that can't take the base is not told on its tasks: `held` says what kept it out, and
   * the caller raises its one card. The merge lists the conflicts it settled in `resolved`.
   */
  readonly forPullRequest?: boolean;
  /**
   * The caller can send a session to resolve conflicts, as a task's verify gate can: a conflict
   * that only needs both sides' work put together is merged into the branch with its markers
   * (`conflicted`), rather than shown as a notice with the gate running on the stale branch. The
   * shipping gate sends the batch's last task (`ship.ts` `sendToMerge`), so it asks too.
   */
  readonly inSession?: true;
  /**
   * A lane is launching on the copy, not a gate starting: a fetch that fails also leaves a notice on
   * the batch, since no gate note will say that the lane started without the base's newer commits.
   */
  readonly atLaunch?: true;
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
  /**
   * Brings the base into the batch's copy as a lane launches on it, so the lane sees what merged
   * while its task waited in the queue (`decisions/2026-11-02-a-lane-starts-on-the-base-as-it-is-now.md`).
   * It is `beforeGate` taking its turn among the batch's gates: a copy with no work of its own is
   * fast-forwarded, one with commits gets the base merged in by the same merge, never reset. A fetch
   * that fails leaves a notice on the batch and the copy as it is. A batch in the builder's own
   * checkout, and a CI fix batch, whose branch is the pull request's, are left alone. Never throws.
   */
  atLaunch(batchId: BatchId, signal: AbortSignal): Promise<BaseUpdate>;
}

/** What a gate's evidence or card says about its base and packages; null when there is nothing. */
export function gateNote(update: BaseUpdate): string | null {
  switch (update.kind) {
    case 'up_to_date':
    case 'merged':
    case 'not_merged':
    case 'conflicted':
    case 'install_broken':
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
  | {
      readonly kind: 'done';
      readonly ok: boolean;
      readonly note: string | null;
      /** Set when the packages still do not resolve after the install: what is missing, in a sentence. */
      readonly broken?: string;
      /**
       * Set when the install failed: starting over again would not help. `refresh` already started
       * over after a failure that left the copy broken, and does not after a timeout (it would only
       * wait again) or a refused host (the same refusal would come back).
       */
      readonly final?: true;
      /** The install failed after a start over, by `refresh` itself or the second pass. */
      readonly startedOver?: true;
    }
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

  /**
   * Shows or clears a notice, or raises a card, without letting the database or the inbox stop the
   * gate. A notice says what the cards an earlier build raised for a conflict or for files in the way
   * said, so those close here too.
   */
  function tell(batch: BatchDto, act: () => void): void {
    try {
      act();
      withdraw(ctx.state, ctx.inbox, batch.projectId, [
        baseConflictKey(batch.id),
        baseKeptKey(batch.id),
      ]);
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
   *
   * `wrote.head` is the head the merge step answered with, read before the install: the merge
   * commit, or the session's last commit resolving its markers. A head that has moved past it since
   * holds a commit the builder made in the worktree meanwhile, and nothing is committed on top of it:
   * the answer stays the head 10db wrote, so a failed catch-up's rewind leaves the branch alone.
   * `wrote.head` becomes the generators' commit once it is made, for a caller whose run then throws.
   */
  async function generate(
    batch: BatchDto,
    project: ProjectDto,
    branch: string,
    path: string,
    merged: SettledMerge,
    wrote: { head: string },
    signal: AbortSignal,
  ): Promise<Regenerated> {
    const regenerating = merged.regenerate ?? [];
    const dirs = regenerating.map((r) => r.dir);
    const current = wrote.head;
    const unchanged = (problem: Unregenerated): Regenerated => ({
      kind: 'done',
      head: current,
      problem,
    });
    /** The problem when HEAD is no longer the head 10db wrote; null while it is. */
    const moved = async (): Promise<string | null> => {
      const now = await ctx.git.head(path);
      return now === current
        ? null
        : `the branch moved to ${now.slice(0, 12)} while 10db ran, a commit 10db did not make, so it didn't commit the generators' output on top of it`;
    };
    const movedBefore = await moved();
    if (movedBefore !== null)
      return unchanged({ why: movedBefore, logPath: null, restored: false });
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
    const movedDuring = await moved();
    if (movedDuring !== null) {
      // What the run wrote is removed: it is not the builder's, and it would be in the next merge's
      // way. The card's "as the merge left them" would not hold, since the builder's commit is on top.
      await ctx.git.restoreDirs(path, dirs);
      return unchanged({ why: movedDuring, logPath: generated.logPath, restored: false });
    }
    const changed = (await ctx.git.changedPaths(path)).filter((file) =>
      dirs.some((dir) => file.startsWith(dir)),
    );
    let head = current;
    if (changed.length > 0) {
      const { sha } = await ctx.git.commit({
        repo: path,
        paths: changed,
        message: `Regenerate ${dirs.join(', ')} after merging origin/${batch.baseBranch}`,
        opId: `regenerate-${merged.head}`,
        branch,
      });
      head = sha;
      wrote.head = sha;
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
   * What kept them from it is one card. Never throws. Resolves with the head 10db wrote (`start`, the
   * head the merge step answered with, or the generators' commit on it; never one read back from the
   * worktree, where the builder may have committed meanwhile) and the note to add, or with a stop.
   */
  async function regenerate(
    batch: BatchDto,
    project: ProjectDto,
    branch: string,
    path: string,
    merged: SettledMerge,
    start: string,
    installed: boolean,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: 'done'; readonly head: string; readonly note: string | null }
    | { readonly kind: 'aborted' }
  > {
    const dirs = (merged.regenerate ?? []).map((r) => r.dir);
    const wrote = { head: start };
    let outcome: Regenerated;
    try {
      outcome = installed
        ? await generate(batch, project, branch, path, merged, wrote, signal)
        : {
            kind: 'done',
            head: start,
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
            head: wrote.head,
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
   * from being regenerated, unless `card` is false: a caller that puts the merge back has nothing
   * for that card's instructions to act on, and says so on its own. Resolves with what the gate's
   * note says of it.
   */
  function unregenerated(
    batch: BatchDto,
    path: string,
    merged: SettledMerge,
    problem: Unregenerated,
    card = true,
  ): string {
    const dirs = (merged.regenerate ?? []).map((r) => r.dir);
    ctx.logger.warn(
      { batchId: batch.id, dirs, reason: problem.why, logPath: problem.logPath },
      'generated files not regenerated after the base merged',
    );
    if (card)
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

  /** The note of a merge whose markers wait for a session; null when there is none or it can't be read. */
  async function pendingOf(batch: BatchDto, path: string): Promise<PendingMerge | null> {
    const ref = mergeRef(ctx.worktreeRoot, batch.id);
    try {
      const text = await ctx.git.keptNote(path, ref);
      if (text === null) return null;
      const parsed = PendingMerge.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
      ctx.logger.warn({ batchId: batch.id, ref }, 'base merge note not understood');
    } catch (error) {
      ctx.logger.warn({ batchId: batch.id, ref, err: why(error) }, 'base merge note not read');
    }
    return null;
  }

  /** The branch holds the base with git's markers still in `paths`: no gate runs until a session resolves them. */
  function conflicted(
    batch: BatchDto,
    base: string,
    paths: readonly string[],
    extra: string | null = null,
    fresh = false,
  ): BaseUpdate {
    return {
      kind: 'conflicted',
      base,
      paths,
      ...(fresh ? { fresh: true as const } : {}),
      note:
        joined(
          `10db merged origin/${batch.baseBranch} into this branch and left git's conflict markers in ${named(paths)} for a session to resolve, so no gate ran on it.`,
          extra,
        ) ?? '',
    };
  }

  /**
   * The session committed a resolution of every file `pending` left with markers: the merge stands
   * with the base as its second parent, so the gate tests the merged branch. The generated
   * directories the merge took from the base are regenerated now, from the resolved sources.
   */
  async function resolved(batch: BatchDto, path: string, pending: PendingMerge): Promise<Merging> {
    const ref = mergeRef(ctx.worktreeRoot, batch.id);
    try {
      await ctx.git.deleteKeptRef(path, ref);
    } catch (error) {
      ctx.logger.warn({ batchId: batch.id, ref, err: why(error) }, 'base merge note not dropped');
    }
    tell(batch, () => {
      hideNotices(ctx.state, batch.id, [
        NOTICE_KEY.baseConflict,
        NOTICE_KEY.baseKept,
        NOTICE_KEY.baseUncommitted,
      ]);
    });
    const head = await ctx.git.head(path);
    ctx.logger.info(
      { batchId: batch.id, base: pending.from, head, files: pending.marked },
      'base conflicts resolved by a session',
    );
    return {
      update: {
        kind: 'merged',
        base: pending.from,
        head,
        note: `10db merged origin/${batch.baseBranch} into this branch, and a session resolved its conflicts in ${named(pending.marked)}.`,
      },
      regenerate:
        pending.regenerate.length > 0
          ? {
              kind: 'merged',
              from: pending.from,
              head: pending.head,
              fastForward: false,
              paths: pending.marked,
              regenerate: pending.regenerate,
            }
          : null,
    };
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
    const forPullRequest = options.forPullRequest === true;
    const holding = (held: BaseHeld) =>
      migrationsFor === undefined && !forPullRequest ? {} : { held };
    const origin = `origin/${batch.baseBranch}`;
    // An earlier gate merged the base and left markers: the merge stands, and what is left is whether
    // a session has resolved them.
    const pending = await pendingOf(batch, path);
    if (pending !== null) {
      const waiting = await ctx.git.conflictMarkers(path, pending.marked);
      if (waiting.length > 0)
        return alone(
          migrationsFor === undefined
            ? conflicted(batch, pending.from, waiting)
            : {
                ...notMerged(
                  batch,
                  `conflict markers in ${named(waiting)}`,
                  `${origin} is merged into this branch, but its conflicts in ${named(waiting)} are not resolved yet, so this gate ran without waiting for them.`,
                ),
                ...holding({ reason: 'conflict', paths: waiting }),
              },
        );
      // The hazard's merge leaves the regeneration to the next gate, which has a clean worktree.
      if (migrationsFor === undefined) return resolved(batch, path, pending);
    }
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
            ? { generated, ...(options.inSession ? { leaveMarkers: true } : {}) }
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
        // The batch's tasks show it; no card asks the builder anything about a conflict that stands.
        // A pull request's caller raises the one card instead.
        // Whatever uncommitted changes a launch named are no longer what keeps the base out.
        tell(batch, () => {
          hideNotices(ctx.state, batch.id, [NOTICE_KEY.baseUncommitted]);
        });
        if (!forPullRequest)
          tell(batch, () => {
            showNotice(
              ctx.state,
              batch.id,
              baseNotices.conflict(batch, path, paths, { ...context, taken, reasons }),
            );
          });
        return alone({
          ...notMerged(
            batch,
            `conflict in ${named(paths)}`,
            `${origin} conflicts with this branch in ${named(paths)}, so this gate ran without its newer commits: a failure they fix shows here until the conflict is resolved, which the batch's tasks show.`,
          ),
          ...holding({ reason: 'conflict', paths }),
        });
      }
      case 'blocked': {
        const { changed, kept } = merged;
        // Only a block that still names uncommitted changes keeps a launch's notice about them.
        if (changed.length === 0)
          tell(batch, () => {
            hideNotices(ctx.state, batch.id, [NOTICE_KEY.baseUncommitted]);
          });
        if (kept.length > 0 && !forPullRequest)
          tell(batch, () => {
            showNotice(ctx.state, batch.id, baseNotices.kept(batch, path, kept, context));
          });
        // A gate's note says it ran without the base; a lane launching has no gate note, so the
        // batch's tasks are told it started on the stale copy. A gate meeting a notice that is already
        // showing brings it up to date, so it names the files in the way now, not the ones a launch saw.
        const showing = batch.notices.some((n) => n.key === NOTICE_KEY.baseUncommitted);
        if (changed.length > 0 && (options.atLaunch || showing))
          tell(batch, () => {
            showNotice(ctx.state, batch.id, baseNotices.uncommitted(batch, changed));
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
        });
      }
      case 'up_to_date':
      case 'merged':
        break;
    }
    // The branch holds the base, the builder's own hand merge included: nothing is in its way.
    tell(batch, () => {
      hideNotices(ctx.state, batch.id, [
        NOTICE_KEY.baseConflict,
        NOTICE_KEY.baseKept,
        NOTICE_KEY.baseUncommitted,
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
    const marked = merged.marked ?? [];
    if (marked.length > 0) {
      // The merge commit stands with git's markers in these files. The generated directories wait
      // for the sources they come from, so 10db keeps what to regenerate until they are resolved.
      const note: PendingMerge = {
        from: merged.from,
        head: merged.head,
        marked: [...marked],
        regenerate: (merged.regenerate ?? []).map((r) => ({ dir: r.dir, dropped: [...r.dropped] })),
      };
      // The note names the merge commit, so it can only be kept once the merge is made. Without it
      // the next gate finds the branch up to date with the base, and nothing would regenerate the
      // directories or report a migration they dropped: so a note that can't be kept is a card.
      let unkept: string | null = null;
      try {
        await ctx.git.keepNote(path, mergeRef(ctx.worktreeRoot, batch.id), JSON.stringify(note));
      } catch (error) {
        ctx.logger.warn({ batchId: batch.id, err: why(error) }, 'base merge note not kept');
        // The migrations the base's directory dropped from the branch are only in the note, so
        // name them here: otherwise the builder would diff against the merge's first parent.
        const dropped = note.regenerate.flatMap((r) => r.dropped).filter((f) => f.endsWith('.sql'));
        const lost =
          dropped.length > 0
            ? `, and the merge removed ${named(dropped)} from the branch, which nothing will check was made again`
            : '';
        const reason = `10db couldn't keep the note of what to regenerate (${why(error)}), so it won't regenerate them once the conflicts in ${named(marked)} are resolved${lost}`;
        unkept = `10db couldn't keep a note of this merge (${why(error)}), so the next gate won't know that ${named(marked)} still hold conflict markers.`;
        if (note.regenerate.length > 0)
          unkept = `${unregenerated(batch, path, merged, { why: reason, logPath: null, restored: false })} ${unkept}`;
      }
      ctx.logger.info(
        { batchId: batch.id, base: merged.from, head: merged.head, files: marked },
        'base merged with conflict markers left for a session',
      );
      tell(batch, () => {
        showNotice(ctx.state, batch.id, baseNotices.resolving(batch, marked));
      });
      return alone(conflicted(batch, merged.from, marked, joined(unmoved, unkept), true));
    }
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
        ...(forPullRequest ? { resolved: merged.resolved ?? [] } : {}),
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
    const first = await installOnce(batch, project, path, signal, false);
    if (first.kind !== 'done' || first.broken === undefined) return first;
    // A failed install was already started over by `refresh`, or was a timeout or a refused host
    // that a repeat would only meet again: it is reported as it is. An install that exited zero gets
    // the second pass, and `refresh` adds no retry to a start over it was asked for, so one gate
    // runs an install twice at most.
    if (first.final === true) return first;
    // The first recovery is automatic: remove node_modules, install from nothing, and let the step
    // run if that resolves. Only a second broken install in a row is reported
    // (`decisions/2026-11-03-a-broken-install-repairs-itself-once.md`).
    ctx.logger.warn(
      { batchId: batch.id, unresolved: first.broken },
      'worktree install left the copy broken; starting over once',
    );
    const second = await installOnce(batch, project, path, signal, true);
    if (second.kind !== 'done') return second;
    // What the second pass answers can't say the copy is whole: it may have thrown, or found no
    // node_modules to expect anything of. So the copy itself is asked, and only a whole one goes on.
    // An install that exited non-zero with every link whole goes on too, with its failure in the note.
    const after = checkInstall(path);
    if (after.kind !== 'whole') {
      return {
        ...second,
        ok: false,
        broken: after.kind === 'broken' ? describeBroken(after) : first.broken,
      };
    }
    try {
      showNotice(ctx.state, batch.id, installNotices.repaired(first.broken, ctx.clock.now()));
    } catch (error) {
      ctx.logger.warn({ batchId: batch.id, err: why(error) }, 'install notice not written');
    }
    return second;
  }

  /** One install, and the check after it; `again` removes `node_modules` first whatever it holds. */
  async function installOnce(
    batch: BatchDto,
    project: ProjectDto,
    path: string,
    signal: AbortSignal,
    again: boolean,
  ): Promise<Installed> {
    try {
      const lockfile = await ctx.git.blobAt(path, 'HEAD', PNPM_LOCKFILE);
      if (lockfile === null) return { kind: 'done', ok: true, note: null };
      const recorded = installedLockfile(db, batch.id);
      // A copy that was installed (it has a node_modules, or an install passed and was recorded)
      // must still resolve what its lockfile names, whether or not the lockfile changed: an install
      // made outside the sandbox, or one the sandbox stopped half way, leaves a node_modules the
      // gate's tools cannot start from. A project with neither was never installed, and is left so.
      const expected = existsSync(join(path, 'node_modules')) || recorded !== null;
      const before = expected ? checkInstall(path) : { kind: 'not_pnpm' as const };
      if (lockfile === recorded && before.kind !== 'broken' && !again)
        return { kind: 'done', ok: true, note: null };
      if (before.kind === 'broken')
        ctx.logger.warn(
          { batchId: batch.id, unresolved: before.unresolved, total: before.total },
          'worktree packages do not match the lockfile; installing again',
        );
      const installed = await ctx.dependencies.refresh({
        batch: getBatch(db, batch.id),
        project,
        path,
        signal,
        // A broken copy is one an install is expected for, even when its node_modules is gone.
        ...(before.kind === 'broken' || again ? { seeded: false } : {}),
        ...(again ? { startOver: true as const } : {}),
      });
      await recordInstall(ctx, batch.id, path, installed);
      const after = expected && installed.kind !== 'aborted' ? checkInstall(path) : null;
      const broken = after?.kind === 'broken' ? describeBroken(after) : undefined;
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
          try {
            await raiseInstallHostCards(ctx, project.id, installed);
          } catch (error) {
            ctx.logger.warn({ batchId: batch.id, err: why(error) }, 'base card not updated');
          }
          const how = installed.timedOut ? 'timed out' : `exit ${String(installed.exitCode)}`;
          const blocked =
            installed.blockedHosts.length === 0
              ? ''
              : ` The sandbox blocked it from reaching ${named(installed.blockedHosts)}.`;
          return {
            kind: 'done',
            ok: false,
            note: `The install this branch's lockfile needs failed (${how}; log: ${installed.logPath}), so its packages may not match it.${blocked}`,
            final: true as const,
            ...(again || (!installed.timedOut && installed.blockedHosts.length === 0)
              ? { startedOver: true as const }
              : {}),
            ...(broken === undefined ? {} : { broken }),
          };
        }
        case 'installed':
          ctx.logger.info(
            { batchId: batch.id, logPath: installed.logPath, durationMs: installed.durationMs },
            'worktree dependencies installed',
          );
          return {
            kind: 'done',
            ok: broken === undefined,
            note: null,
            ...(broken === undefined ? {} : { broken }),
          };
        case 'skipped':
          return {
            kind: 'done',
            ok: broken === undefined,
            note: null,
            ...(broken === undefined ? {} : { broken }),
          };
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
      if (options.atLaunch)
        try {
          showNotice(ctx.state, batch.id, baseNotices.fetchFailed(batch, error));
        } catch (noticeError) {
          ctx.logger.warn({ batchId, err: why(noticeError) }, 'fetch notice not written');
        }
      merging = alone(
        notMerged(
          batch,
          why(error),
          `10db couldn't fetch ${batch.baseBranch} from origin (${why(error)}), so this gate ran on the branch without any newer commits on ${batch.baseBranch}.`,
        ),
      );
    }
    if (merging === null)
      try {
        hideNotices(ctx.state, batch.id, [NOTICE_KEY.baseFetch]);
      } catch (error) {
        ctx.logger.warn({ batchId, err: why(error) }, 'fetch notice not cleared');
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
    // The packages still do not resolve what the lockfile names, so the gate's tools would not even
    // start; the gate does not run, and the generated directories wait for a working install. A
    // pull request's catch-up only tests and pushes a merge, so with none the install stops nothing,
    // and a merge it does stop goes back, with the catch-up's own card saying so.
    const forPullRequest = options.forPullRequest === true;
    if (installed.broken !== undefined && (!forPullRequest || merged.kind === 'merged')) {
      const left = (pending?.regenerate ?? []).map((r) => r.dir);
      if (pending !== null)
        unregenerated(
          batch,
          path,
          pending,
          { why: 'the install is broken', logPath: null, restored: false },
          !forPullRequest,
        );
      return {
        kind: 'install_broken',
        note:
          joined(
            merged.note,
            `The install in this copy is broken: ${installed.broken}. 10db installed from the lockfile${installed.final === true && installed.startedOver !== true ? ' and that install did not bring them back' : ', then removed node_modules and installed again by itself, and neither install brought them back'}${installed.note === null ? '' : ` (${installed.note})`}. This is the copy's packages, not the task's code, so no fix attempt was counted.`,
          ) ?? 'The install in this copy is broken.',
        ...(merged.kind === 'merged' ? { head: merged.head } : {}),
        ...(left.length > 0 ? { unregenerated: left } : {}),
      };
    }
    switch (merged.kind) {
      // Installed now, so the session works with the merged packages; its markers are not regenerated from.
      case 'conflicted':
        return { ...merged, note: joined(merged.note, installed.note) ?? merged.note };
      case 'not_merged':
        return { ...merged, note: joined(merged.note, installed.note) ?? merged.note };
      case 'up_to_date':
        return { ...merged, note: joined(merged.note, installed.note) };
      // The merge step never says so: only the install does, above.
      case 'install_broken':
        return merged;
      case 'merged': {
        if (pending === null) return { ...merged, note: joined(merged.note, installed.note) };
        // Its own stop says so on the card; once it has run, a stop leaves nothing undone.
        const regenerated = await regenerate(
          batch,
          project,
          batch.branch,
          path,
          pending,
          // Read by the merge step, before the install: the head 10db's merge (or the session) left.
          merged.head,
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

  const baseUpdates: BaseUpdates = {
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
    async atLaunch(batchId, signal) {
      const batch = getBatch(db, batchId);
      // The builder's own checkout is never merged into, and a CI fix batch's branch is the pull
      // request's, which stays at the head CI failed on.
      if (batch.worktreePath === null || batch.ciFixOf !== null)
        return { kind: 'up_to_date', note: null };
      const update = await baseUpdates.gate(batchId, signal, () =>
        baseUpdates.beforeGate(batchId, signal, { atLaunch: true }),
      );
      return update ?? { kind: 'aborted' };
    },
  };
  return baseUpdates;
}
