import { readFile } from 'node:fs/promises';
import {
  BatchState,
  CloseStep,
  ConflictError,
  Delivery,
  DomainError,
  PassClosePageChoice,
  PassNoticeKind,
  PassState,
  SharedChoiceKind,
  WorkstreamState,
  type PassCloseAnswerDto,
  type PassCloseContinueDto,
  type PassClosePreviewDto,
  type PassCloseRequest,
  type PassDto,
  type PassGateFailedDetail,
  type PassId,
  type ProjectId,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import {
  clearPassNotice,
  closePass,
  dropAllowThisOffers,
  getBatch,
  getPass,
  getPassProgress,
  getProject,
  getTask,
  getWorkstreamRow,
  listPassTasks,
  listPassesIn,
  listSharedChanges,
  maxGrantedSeq,
  openHolds,
  reopenClosingPass,
  rewindSharedLanded,
  setClosePlan,
  setCloseStep,
  setPassNotice,
  transitionBatch,
  type WriteContext,
} from '@10db/db';
import { jobKey, JobQueue, PASS_GATE_NOTICE } from '../delivery';
import { GitNetworkError, GitTrustError, PassFolderOffBranchError, shellWord } from '../git';
import { flagCard } from '../inbox';
import {
  checkCloseRequest,
  closeChanges,
  closePages,
  closePreview,
  type CloseGateWhere,
} from './close-lists';
import { fastForwardReturn } from './fast-forward';
import { passFolderOn } from './folder';
import { pageMatcher, passBranch, passKeptRef } from './kept-work';
import {
  carryOver,
  carryOverDue,
  followOnPush,
  isMergedClose,
  mergedClosePlan,
  mergedWhileOpen,
} from './merged-open';
import { keepOrLetGo, landOnBranch, landSharedChanges } from './shared-chain';
import { endSignOffWaits, signOffSteps, SignOffFrom } from './sign-off';
import { takeOutSteps, TakeOutWithin, type TakeOutDeps } from './take-out';
import { unfinishedPages } from './unowned';

// Workbench spec §5.4, §5.5, §12: Close Pass, in its recorded steps (`passes.close_step`), so a
// restart goes on from the next and a step done before is not done twice. Each step's write holds
// only while the pass is closing, so an Abandon that took the pass over stops the close at its next
// write. A failed gate puts the pass back to OPEN with as little undone as the order allows.

/**
 * What a close needs of its pull request and its gate (7b's `PassShipDeps`, injected by the
 * composition root, since `pass/` reaches delivery's ship only through this seam).
 */
export interface CloseShip {
  gatePassTip(i: {
    passId: PassId;
    sha: string;
    where: 'scratch' | 'folder';
    signal: AbortSignal;
  }): Promise<{
    passed: boolean;
    aborted: boolean;
    logPath: string;
    /** The end of the gate's log; empty when it did not run. */
    tail: string;
    dirtyNamed: readonly string[];
  }>;
  pushPassBranch(passId: PassId, signal: AbortSignal): Promise<'pushed' | 'no_origin'>;
  ensurePassPr(
    i: { passId: PassId; ready: boolean },
    signal: AbortSignal,
  ): Promise<{ url: string } | null>;
  stopPassChecks(passId: PassId): Promise<void>;
  openFollowOnPr(passId: PassId, signal: AbortSignal): Promise<{ url: string } | null>;
}

/** What a close needs: a take-out's, the ship's seam, and where the project gates a pass. */
export type CloseDeps = TakeOutDeps & {
  readonly ship: CloseShip;
  readonly gateWhere: (pass: PassDto) => CloseGateWhere;
  /** How often a close whose folder is off the pass's branch looks again; `CLOSE_FOLDER_POLL_MS`. */
  readonly folderPollMs?: number;
  /** Opens the pass a merged pass's unfinished pages carry over to, as Start Pass does. */
  readonly openFollowOn?: (input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly taskIds: readonly TaskId[];
    readonly pageCap: number;
  }) => Promise<{ readonly pass: PassDto }>;
};

/** How often a close waiting for Your folder to be back on the pass's branch reads it again. */
export const CLOSE_FOLDER_POLL_MS = 2_000;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Waits while Your folder is off the pass's branch (spec §5.1, §12): the pass's folder card says so,
 * and is withdrawn once the folder is back, when the close goes on. Nothing is landed or moved while
 * the folder holds another branch's files. With `orReturned`, a folder already on the return branch
 * at the pass's tip counts, as a fast-forward cut short between its steps leaves it. Answers whether
 * it waited.
 */
async function folderBack(
  deps: CloseDeps,
  passId: PassId,
  signal: AbortSignal,
  orReturned = false,
): Promise<boolean> {
  for (let waited = false; ; waited = true) {
    const pass = getPass(deps.state.db, passId);
    if (pass.state !== PassState.Closing || signal.aborted) throw new CloseStoppedError(passId);
    const repo = getProject(deps.state.db, pass.projectId).repoPath;
    if (
      orReturned &&
      (await deps.git.currentBranch(repo)) === pass.returnBranch &&
      (await deps.git.commitAt(repo, pass.returnBranch)) ===
        (await deps.git.commitAt(repo, passBranch(deps.state.db, pass)))
    )
      return waited;
    if (await passFolderOn(deps, passId)) return waited;
    await pause(deps.folderPollMs ?? CLOSE_FOLDER_POLL_MS, signal);
  }
}

/** The pass is no longer closing (an Abandon took it over, or its gate reopened it): the close stops. */
export class CloseStoppedError extends DomainError {
  override readonly name = 'CloseStoppedError';
  constructor(passId: PassId) {
    super('conflict', `Pass ${passId} is no longer closing`);
  }
}

/**
 * The close's gate was stopped before it finished by something other than an Abandon (an update
 * draining the gates): the close stops with its notice, and Close Pass runs it again.
 */
class CloseGateStoppedError extends DomainError {
  override readonly name = 'CloseGateStoppedError';
  constructor() {
    super('conflict', 'the gate was stopped before it finished');
  }
}

/** The fold key of the card a close's failed gate raises. */
export const gateFailedKey = (passId: PassId): string => `pass-gate:${passId}`;

/** The header notice that says why a close is stuck, cleared once it goes on. */
const CLOSE_NOTICE = 'close';

/**
 * The header notice that the close pushed but could not make its pull request ready: the close goes
 * on, and the notice stays for the builder to finish it on GitHub.
 */
const PR_READY_NOTICE = 'close-pr-ready';

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The pages a failed gate's log names: each page whose landed file the log mentions. */
async function namedInLog(
  deps: CloseDeps,
  pass: PassDto,
  logPath: string,
): Promise<{ taskId: TaskDto['id']; title: string }[]> {
  const db = deps.state.db;
  const text = await readFile(logPath, 'utf8').catch(() => '');
  if (text === '') return [];
  const project = getProject(db, pass.projectId);
  const tip = await deps.git.commitAt(project.repoPath, passBranch(db, pass));
  const files = (await deps.git.filesChangedBetween(project.repoPath, pass.startSha, tip)).filter(
    (path) => text.includes(path),
  );
  return listPassTasks(db, pass.id)
    .filter((task) => files.some(pageMatcher(db, project, task, pass.id)))
    .map((task) => ({ taskId: task.id, title: task.title }));
}

/**
 * A close's gate failed (spec §5.4, call 17): in one write the batch goes `SHIPPING → FAILED → OPEN`
 * and the pass back to `OPEN` with no close step, its landed mark before any shared change still to
 * land, and a card names the pages the failure names. It offers no Retry: the next Close Pass runs
 * the gate again. Nothing below the gate has happened.
 */
async function failGate(
  deps: CloseDeps,
  pass: PassDto,
  where: 'scratch' | 'folder',
  ran: { readonly logPath: string; readonly tail: string },
): Promise<void> {
  const tasks = await namedInLog(deps, pass, ran.logPath);
  // The pages this close took out before a gate in the folder: those its plan set to Take Out.
  const takenOut =
    where === 'folder'
      ? (getPassProgress(deps.state.db, pass.id).closePlan?.pages ?? [])
          .filter((page) => page.choice === PassClosePageChoice.TakeOut)
          .map((page) => getTask(deps.state.db, page.taskId).title)
      : [];
  const detail: PassGateFailedDetail = {
    kind: 'pass_gate_failed',
    passId: pass.id,
    where,
    logPath: ran.logPath === '' ? null : ran.logPath,
    tasks,
  };
  const named =
    tasks.length === 0 ? '' : ` It names files of ${tasks.map((t) => t.title).join(', ')}.`;
  const one = takenOut.length === 1;
  const inFolder =
    takenOut.length === 0
      ? 'in Your folder, so the pass is open again'
      : `in Your folder, after ${takenOut.join(', ')} ${one ? 'was' : 'were'} taken out, so the pass is open again without ${one ? 'it' : 'them'}`;
  const place =
    where === 'scratch'
      ? 'in a scratch worktree of the tip, before any page was taken out, so the pass is open again as it was'
      : `${inFolder}${takenOut.length === 0 ? '' : `; ${one ? 'its' : 'their'} work is kept with ${one ? 'its task' : 'their tasks'}`}`;
  deps.state.write((ctx) => {
    if (!reopenClosingPass(ctx, pass.id)) return;
    // A change chosen Drop was passed over at step 2 and its take-out has not dropped it: it lands
    // with the next sign-off or close that needs it.
    rewindSharedLanded(ctx, pass.id);
    const batch = getBatch(ctx.tx, pass.batchId);
    if (batch.state === BatchState.Shipping)
      transitionBatch(ctx, batch.id, { to: BatchState.Failed, reason: 'the close gate failed' });
    if (getBatch(ctx.tx, batch.id).state === BatchState.Failed)
      transitionBatch(ctx, batch.id, { to: BatchState.Open, reason: 'the pass is open again' });
    clearPassNotice(ctx, pass.id, CLOSE_NOTICE);
    // A scratch gate's notice is its own; one in the folder is said here, once the pass is open.
    if (where === 'folder')
      setPassNotice(ctx, pass.id, {
        id: PASS_GATE_NOTICE,
        kind: PassNoticeKind.GateFailed,
        text: `The gate failed ${inFolder}:\n${ran.tail}`,
        sendable: true,
        cardId: null,
        at: ctx.now,
      });
    flagCard(ctx, {
      projectId: pass.projectId,
      workstreamId: null,
      title: `The gate failed as UI Workbench pass "${pass.name}" closed`,
      body: `The gate ran ${place}.${named} Finish runs it again.`,
      foldKey: gateFailedKey(pass.id),
      refresh: true,
      detail,
    });
  });
}

/** Whether nothing waits after the close: the fast-forward is the landing (W8, call 19). */
async function settlesAtClose(deps: CloseDeps, pass: PassDto): Promise<boolean> {
  const db = deps.state.db;
  const project = getProject(db, pass.projectId);
  return (
    project.delivery === Delivery.Local ||
    getBatch(db, pass.batchId).repo === null ||
    (await deps.git.remoteUrl(project.repoPath, 'origin')) === null
  );
}

/**
 * The close's steps 2 to 8 (spec §5.4) for a caller holding the project's delivery key, from the
 * step its row records: 2 the pass's checks stop, every session stops again, the pages set to Sign
 * Off Now are signed off in the plan's order, then the placements and the shared changes kept land
 * (commits only); 3 the batch ships and, where copies are allowed, the gate runs in a scratch
 * worktree on the tip; 4 once Your folder is on the pass's branch, the other unfinished pages are
 * taken out, inside the close, so files that keep changing are left and named; 5 where the gate runs
 * in the folder, it runs now; 6 the branch is pushed and its pull request made ready, never set to
 * merge itself; 7 D8's fast-forward, its step recorded before the move; 8 one write ships the batch
 * and closes the pass, settled where nothing waits for a merge, after the signed-off pages' kept
 * refs go. A gate that fails or is aborted ends the job.
 */
export async function closeSteps(
  deps: CloseDeps,
  passId: PassId,
  signal: AbortSignal,
): Promise<void> {
  const db = deps.state.db;
  const closing = (): PassDto => {
    const pass = getPass(db, passId);
    if (pass.state !== PassState.Closing || signal.aborted) throw new CloseStoppedError(passId);
    return pass;
  };
  const step = (): number => getPassProgress(db, passId).closeStep ?? 0;
  const record = (next: CloseStep): void => {
    if (!deps.state.write((ctx) => setCloseStep(ctx, passId, next)))
      throw new CloseStoppedError(passId);
  };
  let pass = closing();
  const plan = getPassProgress(db, passId).closePlan;
  if (plan === null) throw new ConflictError(`Pass "${pass.name}" is closing with no plan`);
  const project = getProject(db, pass.projectId);
  const repo = project.repoPath;
  const branch = passBranch(db, pass);
  const tip = (): Promise<string> => deps.git.commitAt(repo, branch);
  const where = deps.gateWhere(pass);
  // A close for a pull request that merged while the pass was open gates and pushes nothing.
  const merged = isMergedClose(plan);

  if (step() < CloseStep.Landed) {
    await folderBack(deps, passId, signal);
    await deps.ship.stopPassChecks(passId);
    for (const task of listPassTasks(db, passId))
      if (task.workstreamId !== null) await deps.stopLane(task.workstreamId);
    for (const page of plan.pages) {
      if (page.choice !== PassClosePageChoice.SignOff) continue;
      closing();
      await signOffSteps(deps, { taskId: page.taskId, from: SignOffFrom.Close });
    }
    for (const file of plan.files) {
      if (file.placeIn === null) continue;
      closing();
      const record = await deps.git.recordPaths({ repo, base: await tip(), paths: [file.path] });
      const title = listPassTasks(db, passId).find((t) => t.id === file.placeIn)?.title ?? '';
      await landOnBranch(deps.git, {
        repo,
        branch,
        from: record.sha,
        paths: [file.path],
        message: `${title}: ${file.path}\n\n10db-task: ${file.placeIn}\n`,
        opId: `pass:${passId}:place:${file.path}`,
      });
    }
    // Every turn has stopped: a hold still open is kept, so what it changed lands or is dropped;
    // one that cannot be kept is let go, its files left in the folder, so the close goes on.
    for (const hold of openHolds(db, passId)) await keepOrLetGo(deps, hold.claimId);
    closing();
    await landSharedChanges(deps, {
      passId,
      upTo: maxGrantedSeq(db, passId) ?? 0,
      passOver: plan.shared.filter((c) => c.choice === SharedChoiceKind.Drop).map((c) => c.seq),
    });
    record(CloseStep.Landed);
  }

  if (step() < CloseStep.ScratchGated) {
    deps.state.write((ctx) => {
      if (getPass(ctx.tx, passId).state !== PassState.Closing) return;
      const batch = getBatch(ctx.tx, pass.batchId);
      if (batch.state === BatchState.Open)
        transitionBatch(ctx, batch.id, { to: BatchState.Shipping, reason: 'the pass is closing' });
    });
    if (where === 'scratch' && !merged) {
      const ran = await deps.ship.gatePassTip({ passId, sha: await tip(), where, signal });
      if (ran.aborted) {
        closing();
        throw new CloseGateStoppedError();
      }
      if (!ran.passed) {
        await failGate(deps, closing(), 'scratch', ran);
        return;
      }
    }
    record(CloseStep.ScratchGated);
  }

  if (step() < CloseStep.TakenOut) {
    // A take-out off the pass's branch keeps the last kept commit and writes no file: the pages it
    // takes out would stay half done in the folder, owned by no page once the pass lands.
    await folderBack(deps, passId, signal);
    for (const task of unfinishedPages(db, passId)) {
      closing();
      const mine = new Set(
        listSharedChanges(db, passId)
          .filter((c) => c.taskId === task.id)
          .map((c) => c.seq),
      );
      await takeOutSteps(deps, {
        taskId: task.id,
        within: TakeOutWithin.Close,
        shared: plan.shared.filter((c) => mine.has(c.seq)),
      });
    }
    record(CloseStep.TakenOut);
  }

  if (step() < CloseStep.FolderGated) {
    if (where === 'folder' && !merged) {
      await folderBack(deps, passId, signal);
      const ran = await deps.ship.gatePassTip({ passId, sha: await tip(), where, signal });
      if (ran.aborted) {
        closing();
        throw new CloseGateStoppedError();
      }
      if (!ran.passed) {
        await failGate(deps, closing(), 'folder', ran);
        return;
      }
    }
    record(CloseStep.FolderGated);
  }

  if (step() < CloseStep.Pushed && merged) {
    closing();
    await followOnPush(deps, passId, plan, signal);
    record(CloseStep.Pushed);
  }

  if (step() < CloseStep.Pushed) {
    closing();
    if ((await deps.ship.pushPassBranch(passId, signal)) === 'pushed') {
      try {
        await deps.ship.ensurePassPr({ passId, ready: true }, signal);
      } catch (error) {
        // The branch is pushed; the pull request is GitHub's to finish, and the close goes on.
        deps.state.write((ctx) => {
          setPassNotice(ctx, passId, {
            id: PR_READY_NOTICE,
            kind: PassNoticeKind.PrNotOpened,
            text: `The pass's branch is pushed, but its pull request could not be made ready for review: ${errorText(error)}. Open or mark it on GitHub.`,
            sendable: false,
            cardId: null,
            at: ctx.now,
          });
        });
      }
    }
    record(CloseStep.Pushed);
  }

  if (step() < CloseStep.FastForwarded) {
    await folderBack(deps, passId, signal, true);
    closing();
    // Recorded before the move: from here an Abandon is refused, so none takes over a pass whose
    // return branch has moved. A rerun moves it again, done where it finds it done.
    record(CloseStep.FastForwarded);
  }
  if (step() < CloseStep.Closed) {
    await folderBack(deps, passId, signal, true);
    pass = closing();
    await fastForwardReturn(deps, pass);
  }

  pass = closing();
  for (const task of listPassTasks(db, passId))
    if (
      task.workstreamId !== null &&
      getWorkstreamRow(db, task.workstreamId).state === WorkstreamState.Done
    )
      await deps.git.deleteKeptRef(repo, passKeptRef(passId, task.id));
  const settled = await settlesAtClose(deps, pass);
  deps.state.write((ctx) => {
    if (!closePass(ctx, passId, { settled })) return;
    // The pass's pages take no go-ahead any more.
    dropAllowThisOffers(
      ctx,
      listPassTasks(ctx.tx, passId).map((t) => t.id),
    );
    const batch = getBatch(ctx.tx, pass.batchId);
    if (batch.state === BatchState.Shipping)
      transitionBatch(ctx, batch.id, { to: BatchState.Shipped, reason: 'the pass closed' });
  });
}

/** A pass's close: its lists, its confirm, the job that runs it, and the abort an Abandon raises. */
export interface PassCloses {
  /** `GET /passes/:passId/close`: the lists, stopping nothing. */
  preview(passId: PassId): Promise<PassClosePreviewDto>;
  /**
   * `POST /passes/:passId/close`: stops every session of the pass, builds the lists again, and
   * closes only if they are what the builder confirmed; else answers them with what changed.
   * Refused (409) while the pass is neither open nor closing or Your folder is off its branch, and
   * for choices the lists do not allow. A closing pass's close goes on from its recorded step, on
   * the plan it was confirmed with, whatever the request.
   */
  close(passId: PassId, request: PassCloseRequest): Promise<PassCloseAnswerDto>;
  /**
   * `POST /passes/:passId/close/continue`: the close of a closing pass goes on from its recorded step,
   * on the plan it was confirmed with (a job still running runs once more after it ends). Refused
   * (409) for a pass that is not closing.
   */
  continueClose(passId: PassId): PassCloseContinueDto;
  /** Raises the abort of the pass's close job and waits for it to stop. */
  abort(passId: PassId): Promise<void>;
  /**
   * Call 6: closes an open pass whose pull request has merged, from a plan 10db writes, then carries
   * its unfinished pages over to a follow-on pass. Does nothing for any other pass.
   */
  closeMerged(passId: PassId): void;
  /**
   * Start-up: each closing pass goes on from its last step, an open one whose pull request merged
   * closes, and a merged one whose pages were not yet carried over carries them.
   */
  resume(): void;
}

export function createPassCloses(deps: CloseDeps): PassCloses {
  const db = deps.state.db;
  const running = new Map<
    PassId,
    { abort: AbortController; done: Promise<void>; again: boolean }
  >();

  /**
   * Runs the pass's close job. Asked while it runs (a Close Pass as it stops on an error, or a
   * merged close written after its gate reopened the pass), it runs once more after it ends, while
   * the pass is still closing.
   */
  function run(passId: PassId): void {
    const current = running.get(passId);
    if (current) {
      current.again = true;
      return;
    }
    const pass = getPass(db, passId);
    const abort = new AbortController();
    const done = new Promise<void>((resolve) => {
      deps.jobs.run(
        jobKey({ projectId: pass.projectId, worktreePath: null }, JobQueue.Cut),
        async (jobSignal) => {
          const signal = AbortSignal.any([jobSignal, abort.signal]);
          // The close is going on: the notice that said it stopped comes down until it stops again.
          deps.state.write((ctx) => {
            if (getPass(ctx.tx, passId).state === PassState.Closing)
              clearPassNotice(ctx, passId, CLOSE_NOTICE);
          });
          try {
            // Your folder that left the pass's branch in the middle of a step is waited for, with
            // the folder card, and the close goes on from its recorded step. A refusal with the
            // folder already back is taken once more, then it stops the close.
            for (let again = false; ;) {
              try {
                await closeSteps(deps, passId, signal);
                break;
              } catch (error) {
                if (!(error instanceof PassFolderOffBranchError)) throw error;
                const waited = await folderBack(deps, passId, signal);
                if (!waited && again) throw error;
                again = !waited;
              }
            }
            deps.state.write((ctx) => {
              clearPassNotice(ctx, passId, CLOSE_NOTICE);
            });
            // Outside this job: the follow-on pass opens in the same delivery queue.
            void carryOver(deps, passId).catch((error: unknown) => {
              deps.logger.warn({ passId, err: errorText(error) }, 'merged pass not carried over');
            });
          } catch (error) {
            if (!(error instanceof CloseStoppedError)) {
              deps.logger.warn({ passId, err: errorText(error) }, 'close did not finish');
              deps.state.write((ctx) => {
                if (getPass(ctx.tx, passId).state !== PassState.Closing) return;
                noticeStuck(ctx, passId, error, deps.gateWhere(getPass(ctx.tx, passId)));
              });
            }
          } finally {
            const again = running.get(passId)?.again === true;
            running.delete(passId);
            resolve();
            if (again && getPass(db, passId).state === PassState.Closing) run(passId);
          }
        },
      );
    });
    running.set(passId, { abort, done, again: false });
  }

  function closeMerged(passId: PassId): void {
    const wrote = deps.state.write((ctx) => {
      if (!mergedWhileOpen(ctx.tx, passId)) return false;
      setClosePlan(ctx, passId, mergedClosePlan(ctx.tx, passId));
      endSignOffWaits(ctx, passId);
      return true;
    });
    if (wrote) run(passId);
  }

  return {
    preview: (passId) => closePreview(deps, passId),
    async close(passId, request) {
      const pass = getPass(db, passId);
      // A close that stopped on an error goes on from its recorded step, on the plan it was
      // confirmed with; one still running is answered as it is.
      if (pass.state === PassState.Closing) {
        run(passId);
        return { outcome: 'closing', pass };
      }
      if (pass.state !== PassState.Open)
        throw new ConflictError(
          `Pass "${pass.name}" is ${pass.state.toLowerCase()}: only an open pass is closed`,
        );
      if (mergedWhileOpen(db, passId)) {
        closeMerged(passId);
        throw new ConflictError(
          `The pull request of pass "${pass.name}" has merged: 10db closes the pass by itself, carrying its unfinished pages over`,
        );
      }
      const repo = getProject(db, pass.projectId).repoPath;
      const on = await deps.git.currentBranch(repo);
      if (on !== passBranch(db, pass))
        throw new ConflictError(
          `Your folder is on ${on ?? 'a detached HEAD'}, not the pass's branch: switch back before closing`,
        );
      checkCloseRequest(await closePreview(deps, passId), request, closePages(db, passId));
      // D25: the agents stop only now, and the close goes on only on the lists they leave.
      for (const task of unfinishedPages(db, passId))
        if (task.workstreamId !== null) await deps.stopLane(task.workstreamId);
      const now = await closePreview(deps, passId);
      if (now.token !== request.token)
        return { outcome: 'changed', preview: now, changed: closeChanges(request, now) };
      // The stop kept each page's turn and may have ended its run: what a page set to Sign Off Now
      // needs, and whether it can be signed off, are read again from what the stop left.
      checkCloseRequest(now, request, closePages(db, passId));
      deps.state.write((ctx) => {
        setClosePlan(ctx, passId, request);
        endSignOffWaits(ctx, passId);
      });
      run(passId);
      return { outcome: 'closing', pass: getPass(db, passId) };
    },
    continueClose(passId) {
      const pass = getPass(db, passId);
      if (pass.state !== PassState.Closing)
        throw new ConflictError(
          `Pass "${pass.name}" is ${pass.state.toLowerCase()}: only a closing pass's close goes on`,
        );
      run(passId);
      return { outcome: 'closing', pass };
    },
    async abort(passId) {
      const job = running.get(passId);
      if (!job) return;
      job.abort.abort();
      await job.done;
    },
    closeMerged,
    resume() {
      for (const pass of listPassesIn(db, PassState.Closing)) run(pass.id);
      for (const pass of listPassesIn(db, PassState.Open)) closeMerged(pass.id);
      for (const state of [PassState.Closed, PassState.Settled])
        for (const pass of listPassesIn(db, state))
          if (carryOverDue(db, pass.id))
            void carryOver(deps, pass.id).catch((error: unknown) => {
              deps.logger.warn(
                { passId: pass.id, err: errorText(error) },
                'merged pass not carried over',
              );
            });
    },
  };
}

/**
 * What a close was doing when it stopped, in words, from the last step it recorded and where the
 * project gates a pass.
 */
function stoppedWhile(step: number, where: CloseGateWhere): string {
  if (step < CloseStep.Landed) return "landing the close's changes";
  if (step < CloseStep.ScratchGated && where === 'scratch')
    return 'running the gate in a separate copy';
  if (step < CloseStep.TakenOut) return 'taking out pages';
  if (step < CloseStep.FolderGated && where === 'folder') return 'running the gate in your folder';
  if (step < CloseStep.Pushed) return "pushing the pass's branch";
  if (step < CloseStep.Closed) return "moving your folder's branch";
  return 'closing the pass';
}

/**
 * Why the close stopped, in 10db's own words: a domain error's message and a typed git error's, the
 * folder off the pass's branch with how to switch it back; null for any other error (SQLite's text, a
 * library's), whose detail stays in the log.
 */
function stoppedBecause(error: unknown): string | null {
  if (error instanceof PassFolderOffBranchError)
    return `${error.message}; switch it back (git switch ${shellWord(error.branch)})`;
  if (
    error instanceof DomainError ||
    error instanceof GitNetworkError ||
    error instanceof GitTrustError
  )
    return error.message;
  return null;
}

/**
 * The header notice of a close that stopped on an error: a plain sentence naming what it was doing,
 * with why when 10db's own words say it, else pointing at the log. Continue Close or the next start
 * goes on, or, before its fast-forward, Abandon ends it. From step 7 the return branch may have moved,
 * and an Abandon is refused.
 */
function noticeStuck(
  ctx: WriteContext,
  passId: PassId,
  error: unknown,
  where: CloseGateWhere,
): void {
  const step = getPassProgress(ctx.tx, passId).closeStep ?? 0;
  const end =
    step >= CloseStep.FastForwarded
      ? `its fast-forward may have moved ${getPass(ctx.tx, passId).returnBranch}, so it can no longer be abandoned`
      : 'Abandon ends it';
  const because = stoppedBecause(error);
  const doing = stoppedWhile(step, where);
  const why =
    because === null
      ? `The close stopped while ${doing}. 10db's log has the detail.`
      : `The close stopped while ${doing}: ${because}.`;
  setPassNotice(ctx, passId, {
    id: CLOSE_NOTICE,
    kind: PassNoticeKind.Close,
    text: `${why} Continue Close goes on from where it stopped, as 10db does when it next starts; ${end}.`,
    sendable: false,
    cardId: null,
    at: ctx.now,
  });
}
