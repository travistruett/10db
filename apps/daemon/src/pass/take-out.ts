import {
  ConflictError,
  isTerminal,
  PassState,
  SharedChoiceKind,
  TakeOutStep,
  TaskStatus,
  WorkstreamState,
  type PassId,
  type SharedChoice,
  type TakeOutResultDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  advanceTakeOut,
  clearLease,
  deleteSignOffWait,
  deleteTakeOut,
  getPass,
  getProject,
  getTask,
  getTaskKeptWork,
  getWorkstreamRow,
  insertSystemNotice,
  insertTakeOut,
  lastTakeOut,
  leavePass,
  openHolds,
  passHoldingTask,
  releaseClaims,
  setTaskKeptWork,
  setTaskStatus,
  settleTurnsLeaving,
  transitionWorkstream,
  type PassTakeOutRow,
  type TaskKeptWork,
  type WriteContext,
} from '@10db/db';
import { jobKey, JobQueue, passDirtRef } from '../delivery';
import { foldHandEdits } from './hand-edits';
import { keepHold } from './shared-chain';
import { dropShared } from './shared-drop';
import { PassFolderOffBranchError } from '../git';
import {
  keepTurnWork,
  keptRef,
  keptWorkFacts,
  pageMatcher,
  passBranch,
  passKeptRef,
  passTaskPlace,
  readKeptRef,
  type KeptWork,
  type PassTaskPlace,
  type PassWorkDeps,
} from './kept-work';

// Workbench spec §5.4: taking a task out of its pass, step by recorded step, so a restart goes on from
// the step its `pass_take_outs` row reached. Its work is kept with the task, its page's files go back
// to what they were without it, and it returns to the Board.

/** What a take-out is part of: the builder's ask alone, or an Abandon or a close, which must finish. */
export const TakeOutWithin = { Alone: 'alone', Abandon: 'abandon', Close: 'close' } as const;
export type TakeOutWithin = (typeof TakeOutWithin)[keyof typeof TakeOutWithin];

/** Ends a pass lane's session, if any, keeping its last work; the runner's, injected. */
export type StopPassLane = (id: WorkstreamId) => Promise<void>;

/** Tells Your folder's watcher which files 10db just wrote there, so they raise no card. */
type DaemonWrote = (repo: string, paths: readonly string[]) => Promise<void>;

/** What a take-out needs: the pass's work in the folder, the runner's stop, the watcher's ear. */
export type TakeOutDeps = PassWorkDeps & {
  readonly stopLane: StopPassLane;
  readonly wrote: DaemonWrote;
};

export interface TakeOutInput {
  readonly taskId: TaskId;
  readonly within: TakeOutWithin;
  /** What becomes of each shared change of the page that has not landed; Keep by default. */
  readonly shared?: readonly SharedChoice[];
}

/** How many times steps 1 to 3 run before the files that keep changing decide. */
const CHECK_TRIES = 3;

const count = (n: number): string => `${String(n)} file${n === 1 ? '' : 's'}`;
const listed = (paths: readonly string[]): string => paths.map((p) => `- ${p}`).join('\n');

/**
 * Step 5 of a take-out, in the caller's write: the task's run is cancelled from whatever state it is
 * in (a queued one would start an ordinary session in the folder the moment the pass let go of it),
 * its claims released, every turn of it ended and settled with nothing Ready, the task leaves the
 * pass for the Board, open, with its kept work recorded, and the thread says so.
 */
export function leavePassForBoard(
  ctx: WriteContext,
  input: {
    readonly taskId: TaskId;
    readonly passId: PassId;
    readonly kept: TaskKeptWork | null;
    /** How many files the kept work holds. */
    readonly files: number;
  },
): void {
  const task = getTask(ctx.tx, input.taskId);
  const pass = getPass(ctx.tx, input.passId);
  const run = task.workstreamId;
  if (run !== null) {
    if (!isTerminal(getWorkstreamRow(ctx.tx, run).state))
      transitionWorkstream(ctx, run, {
        to: WorkstreamState.Cancelled,
        fence: null,
        patch: { currentSessionId: null },
        reason: `taken out of pass "${pass.name}"`,
      });
    releaseClaims(ctx, run);
    clearLease(ctx, run);
  }
  // No turn of the task is left for a later run of it to finish, nor a sign-off waiting for it.
  settleTurnsLeaving(ctx, input.taskId);
  deleteSignOffWait(ctx, input.taskId);
  leavePass(ctx, input.taskId);
  if (task.status !== TaskStatus.Open) setTaskStatus(ctx, input.taskId, TaskStatus.Open);
  setTaskKeptWork(ctx, input.taskId, input.kept);
  advanceTakeOut(ctx, { taskId: input.taskId, passId: input.passId }, { step: TakeOutStep.Done });
  insertSystemNotice(
    ctx,
    input.taskId,
    input.kept === null
      ? `Taken out of the pass "${pass.name}"; it had no work to keep.`
      : `Taken out of the pass "${pass.name}": its work is kept with the task (${count(input.files)}).`,
  );
}

/** The page files whose content on disk is not what `kept` holds: something wrote after the keep. */
async function changedSinceKept(
  deps: PassWorkDeps,
  place: PassTaskPlace,
  kept: {
    readonly keptSha: string | null;
    readonly keptBaseSha: string;
    readonly pageFiles: readonly { path: string }[];
  },
): Promise<string[]> {
  const { git } = deps;
  const mine = pageMatcher(deps.state.db, place.project, place.task, place.pass.id);
  const paths = [
    ...new Set([
      ...kept.pageFiles.map((f) => f.path),
      ...(await git.changedPaths(place.repo)).filter(mine),
    ]),
  ].sort();
  const commit = kept.keptSha ?? kept.keptBaseSha;
  const changed: string[] = [];
  for (const { path, blob } of await git.hashOnDisk(place.repo, paths))
    if ((await git.blobAt(place.repo, commit, path)) !== blob) changed.push(path);
  return changed;
}

/** The task's take-out that has not finished, from a run a restart cut short, or undefined. */
function unfinishedTakeOut(deps: PassWorkDeps, taskId: TaskId): PassTakeOutRow | undefined {
  const row = lastTakeOut(deps.state.db, taskId);
  return row && row.step < TakeOutStep.Done ? row : undefined;
}

/**
 * The take-out's steps (spec §5.4), for a caller already holding the project's delivery key: a close
 * or an Abandon. Goes on from the step the task's unfinished take-out reached, else writes one.
 * 0 stops the lane; 1 folds hand edits; 2 makes a last kept commit; 3 checks the page's files on disk
 * hash as it holds them, running 1 to 3 again up to three times: a take-out asked for alone then stops
 * (the task stays in the pass, the thread names the files), one inside an Abandon or a close leaves
 * those files as they are and goes on; 4 puts each page file back as the pass's branch has it where
 * something landed on it during the pass, else as it was before the pass, hashing each again just
 * before (one changed since is left and named), then drops each shared change chosen Drop, newest
 * first (inside an Abandon or a close without its refusals, never without the hash before each
 * write; a refused one stays on the chain and the thread says why); 5 leaves the pass for the Board,
 * its work at its kept ref. While Your folder is off the pass's branch nothing of the page can be
 * kept and none of its files is written: a take-out asked for alone fails, and one inside an Abandon
 * or a close keeps the last kept commit, writes no file and goes on to step 5.
 */
export async function takeOutSteps(
  deps: TakeOutDeps,
  input: TakeOutInput,
): Promise<TakeOutResultDto> {
  const db = deps.state.db;
  const task = getTask(db, input.taskId);
  const workstreamId = task.workstreamId;
  if (workstreamId === null) throw new ConflictError(`${task.title} has no run to take out`);
  let row =
    unfinishedTakeOut(deps, task.id) ??
    deps.state.write((ctx) => {
      const pass = passHoldingTask(ctx.tx, getTask(ctx.tx, task.id));
      if (!pass) throw new ConflictError(`${task.title} is in no open pass`);
      // The builder's own ask is taken only while the pass is open; an Abandon or a close takes its own.
      if (input.within === TakeOutWithin.Alone && pass.state !== PassState.Open)
        throw new ConflictError(
          `Pass "${pass.name}" is ${pass.state.toLowerCase()}: a page is taken out only while it is open`,
        );
      return insertTakeOut(ctx, {
        taskId: task.id,
        passId: pass.id,
        drops: (input.shared ?? [])
          .filter((c) => c.choice === SharedChoiceKind.Drop)
          .map((c) => c.seq),
      });
    });
  const key = { taskId: task.id, passId: row.passId };
  const pass = getPass(db, row.passId);
  const advance = (patch: Parameters<typeof advanceTakeOut>[2]): PassTakeOutRow =>
    deps.state.write((ctx) => advanceTakeOut(ctx, key, patch));
  const { git } = deps;

  let stillChanging: string[] = row.step >= TakeOutStep.Checked ? [...row.left] : [];
  try {
    if (row.step < TakeOutStep.Stopped) {
      await deps.stopLane(workstreamId);
      row = advance({ step: TakeOutStep.Stopped });
    }
    if (row.step < TakeOutStep.Checked) {
      const place = passTaskPlace(db, task.id);
      for (let tries = row.tries; ;) {
        let kept: KeptWork;
        try {
          await foldHandEdits(deps, { workstreamId });
          if (row.step < TakeOutStep.HandEditsFolded)
            row = advance({ step: TakeOutStep.HandEditsFolded });
          kept = await keepTurnWork(deps, { workstreamId, turnId: null });
        } catch (error) {
          if (!(error instanceof PassFolderOffBranchError) || input.within === TakeOutWithin.Alone)
            throw error;
          // An Abandon or a close must finish, and nothing of the page can be kept while Your
          // folder is off the pass's branch: the last kept commit stands, and step 4 writes nothing.
          const last = await keptWorkFacts(deps, task.id);
          row = advance({
            step: TakeOutStep.Checked,
            keptSha: last.keptSha,
            keptBaseSha: last.keptBaseSha,
          });
          break;
        }
        tries += 1;
        row = advance({
          step: TakeOutStep.Kept,
          tries,
          keptSha: kept.keptSha,
          keptBaseSha: kept.keptBaseSha,
        });
        stillChanging = await changedSinceKept(deps, place, kept);
        if (stillChanging.length === 0) {
          row = advance({ step: TakeOutStep.Checked });
          break;
        }
        if (tries < CHECK_TRIES) continue;
        if (input.within === TakeOutWithin.Alone) {
          const changing = stillChanging;
          deps.state.write((ctx) => {
            deleteTakeOut(ctx, key);
            insertSystemNotice(
              ctx,
              task.id,
              `The page's files kept changing while it was being taken out, so it stays in the pass:\n${listed(changing)}`,
            );
          });
          return {
            taskId: task.id,
            passId: pass.id,
            tookOut: false,
            keptSha: kept.keptSha,
            stillChanging: changing,
            left: [],
          };
        }
        row = advance({ step: TakeOutStep.Checked, left: stillChanging });
        break;
      }
    }
  } catch (error) {
    // A take-out the builder asked for alone that fails before a file is put back leaves the page
    // in the pass as it was, taking messages again; one inside an Abandon or a close goes on from
    // its row.
    if (input.within === TakeOutWithin.Alone && row.step < TakeOutStep.Checked)
      deps.state.write((ctx) => {
        deleteTakeOut(ctx, key);
      });
    throw error;
  }

  const keptBaseSha = row.keptBaseSha;
  if (keptBaseSha === null) throw new ConflictError(`The take-out of ${task.title} kept nothing`);
  const project = getProject(db, pass.projectId);
  const repo = project.repoPath;
  const files =
    row.keptSha === null
      ? []
      : (await git.filesChangedBetween(repo, keptBaseSha, row.keptSha)).filter(
          pageMatcher(db, project, getTask(db, task.id), pass.id),
        );

  if (row.step < TakeOutStep.PutBack) {
    const keptSha = row.keptSha;
    let left: string[] = [];
    // A folder on another branch holds that branch's files: the pass's are never written into it.
    const on = await git.currentBranch(repo);
    const offBranch = on !== passBranch(db, pass);
    if (!offBranch && keptSha !== null) {
      const leftAlready = new Set(row.left);
      const touched = new Set(await git.filesChangedBetween(repo, pass.startSha, keptBaseSha));
      const before = (await readKeptRef(git, repo, passDirtRef(pass.id))) ?? pass.startSha;
      const putBack = files.filter((path) => !leftAlready.has(path));
      const expect = await Promise.all(
        putBack.map(async (path) => ({ path, blob: await git.blobAt(repo, keptSha, path) })),
      );
      const restored = await git.restoreFiles(
        repo,
        putBack.map((path) => ({ path, from: touched.has(path) ? keptBaseSha : before })),
        expect,
      );
      ({ left } = restored);
      // The page's files go back as they were before the pass, outside every claim once step 5
      // releases the page: they are 10db's writes, not a lane's.
      await deps.wrote(repo, restored.written);
      await git.refreshIndex(repo, restored.written);
    }
    // A hold the stop left open is kept first, so a Drop chosen for it has its change.
    if (!offBranch)
      for (const hold of openHolds(db, pass.id))
        if (hold.taskId === task.id && row.drops.includes(hold.seq))
          await keepHold(deps, { claimId: hold.claimId });
    // The shared changes chosen Drop, newest first, so each later one is back before an earlier.
    const kept: string[] = [];
    for (const seq of offBranch ? [] : [...row.drops].sort((a, b) => b - a)) {
      const dropped = await dropShared(deps, {
        passId: pass.id,
        seq,
        force: input.within !== TakeOutWithin.Alone,
      });
      if (dropped.refused !== null)
        kept.push(`Shared change ${String(seq)} is kept on the chain: ${dropped.refused}.`);
      left = [...left, ...dropped.left];
    }
    const changed = left;
    row = deps.state.write((ctx) => {
      if (offBranch)
        insertSystemNotice(
          ctx,
          task.id,
          `Your folder was on ${on ?? 'a detached HEAD'}, not on the pass's branch, so the page's files were left as they are.`,
        );
      if (changed.length > 0)
        insertSystemNotice(
          ctx,
          task.id,
          `Left as they are, because they changed after they were checked:\n${listed(changed)}`,
        );
      for (const line of kept) insertSystemNotice(ctx, task.id, line);
      return advanceTakeOut(ctx, key, {
        step: TakeOutStep.PutBack,
        left: [...row.left, ...changed],
      });
    });
  }

  if (row.step < TakeOutStep.Done) {
    deps.inbox.cancelForWorkstream(workstreamId);
    // Work saved from an earlier take-out that is still not in the folder is never written over:
    // with no new work it stays as it is, else the new kept commit is made on it too.
    const earlier = getTaskKeptWork(db, task.id);
    const moved =
      row.keptSha === null
        ? null
        : await git.moveKeptRef(
            repo,
            passKeptRef(pass.id, task.id),
            keptRef(task.id),
            earlier === null
              ? undefined
              : { sha: earlier.keptSha, base: earlier.keptBaseSha, workBase: keptBaseSha },
          );
    const kept = moved === null ? earlier : { keptSha: moved, keptBaseSha };
    const held =
      kept === null ? [] : await git.filesChangedBetween(repo, kept.keptBaseSha, kept.keptSha);
    deps.state.write((ctx) => {
      leavePassForBoard(ctx, { taskId: task.id, passId: pass.id, kept, files: held.length });
    });
    row = { ...row, step: TakeOutStep.Done };
  }
  return {
    taskId: task.id,
    passId: pass.id,
    tookOut: true,
    keptSha: row.keptSha,
    stillChanging,
    left: [...row.left],
  };
}

/**
 * Takes a task out of its pass as a job under the project's delivery key, as a pass opens, so it never
 * interleaves with an opening, another take-out or an Abandon. The shared changes chosen Drop are
 * recorded on the take-out's row, so a restart follows them.
 */
export function takeOut(deps: TakeOutDeps, input: TakeOutInput): Promise<TakeOutResultDto> {
  const task = getTask(deps.state.db, input.taskId);
  return new Promise<TakeOutResultDto>((resolve, reject) => {
    deps.jobs.run(
      jobKey({ projectId: task.projectId, worktreePath: null }, JobQueue.Cut),
      async () => {
        try {
          resolve(await takeOutSteps(deps, input));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  });
}
