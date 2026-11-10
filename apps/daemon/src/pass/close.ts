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
  type PassClosePreviewDto,
  type PassCloseRequest,
  type PassDto,
  type PassGateFailedDetail,
  type PassId,
  type TaskDto,
} from '@10db/contracts';
import {
  clearPassNotice,
  closePass,
  deleteSignOffWait,
  getBatch,
  getPass,
  getPassProgress,
  getProject,
  getWorkstreamRow,
  listPassTasks,
  listPassesIn,
  listSharedChanges,
  listSignOffWaits,
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
import { jobKey, JobQueue } from '../delivery';
import { flagCard } from '../inbox';
import { checkCloseRequest, closeChanges, closePreview, type CloseGateWhere } from './close-lists';
import { fastForwardReturn } from './fast-forward';
import { passFolderOn } from './folder';
import { pageMatcher, passBranch, passKeptRef } from './kept-work';
import { keepHold, landSharedChanges } from './shared-chain';
import { signOffSteps, SignOffFrom } from './sign-off';
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
    dirtyNamed: readonly string[];
  }>;
  pushPassBranch(passId: PassId, signal: AbortSignal): Promise<'pushed' | 'no_origin'>;
  ensurePassPr(
    i: { passId: PassId; ready: boolean },
    signal: AbortSignal,
  ): Promise<{ url: string } | null>;
  stopPassChecks(passId: PassId): Promise<void>;
}

/** What a close needs: a take-out's, the ship's seam, and where the project gates a pass. */
export type CloseDeps = TakeOutDeps & {
  readonly ship: CloseShip;
  readonly gateWhere: (pass: PassDto) => CloseGateWhere;
  /** How often a close whose folder is off the pass's branch looks again; `CLOSE_FOLDER_POLL_MS`. */
  readonly folderPollMs?: number;
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
 * at the pass's tip counts, as a fast-forward cut short between its steps leaves it.
 */
async function folderBack(
  deps: CloseDeps,
  passId: PassId,
  signal: AbortSignal,
  orReturned = false,
): Promise<void> {
  for (;;) {
    const pass = getPass(deps.state.db, passId);
    if (pass.state !== PassState.Closing || signal.aborted) throw new CloseStoppedError(passId);
    const repo = getProject(deps.state.db, pass.projectId).repoPath;
    if (
      orReturned &&
      (await deps.git.currentBranch(repo)) === pass.returnBranch &&
      (await deps.git.commitAt(repo, pass.returnBranch)) ===
        (await deps.git.commitAt(repo, passBranch(deps.state.db, pass)))
    )
      return;
    if (await passFolderOn(deps, passId)) return;
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

/** The fold key of the card a close's failed gate raises. */
export const gateFailedKey = (passId: PassId): string => `pass-gate:${passId}`;

/** The header notice that says why a close is stuck, cleared once it goes on. */
const CLOSE_NOTICE = 'close';

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
  ran: { readonly logPath: string },
): Promise<void> {
  const tasks = await namedInLog(deps, pass, ran.logPath);
  const detail: PassGateFailedDetail = {
    kind: 'pass_gate_failed',
    passId: pass.id,
    where,
    logPath: ran.logPath === '' ? null : ran.logPath,
    tasks,
  };
  const named =
    tasks.length === 0 ? '' : ` It names files of ${tasks.map((t) => t.title).join(', ')}.`;
  const place =
    where === 'scratch'
      ? 'in a scratch worktree of the tip, before any page was taken out, so the pass is open again as it was'
      : 'in Your folder, after the pages set to Take Out were taken out, so the pass is open again without them; their work is kept with their tasks';
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
    flagCard(ctx, {
      projectId: pass.projectId,
      workstreamId: null,
      title: `The gate failed as Workbench pass "${pass.name}" closed`,
      body: `The gate ran ${place}.${named} Close Pass runs it again.`,
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
 * worktree on the tip; 4 the other unfinished pages are taken out, inside the close, so files that
 * keep changing are left and named; 5 where the gate runs in the folder, it runs now; 6 the branch
 * is pushed and its pull request made ready, never set to merge itself; 7 D8's fast-forward; 8 one
 * write ships the batch and closes the pass, settled where nothing waits for a merge, after the
 * signed-off pages' kept refs go. A gate that fails or is aborted ends the job.
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
      await deps.git.landPaths({
        repo,
        branch,
        from: record.sha,
        paths: [file.path],
        message: `${title}: ${file.path}\n\n10db-task: ${file.placeIn}\n`,
        opId: `pass:${passId}:place:${file.path}`,
      });
    }
    // Every turn has stopped: a hold still open is kept, so what it changed lands or is dropped.
    for (const hold of openHolds(db, passId)) await keepHold(deps, { claimId: hold.claimId });
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
    if (where === 'scratch') {
      const ran = await deps.ship.gatePassTip({ passId, sha: await tip(), where, signal });
      if (ran.aborted) throw new CloseStoppedError(passId);
      if (!ran.passed) {
        await failGate(deps, closing(), 'scratch', ran);
        return;
      }
    }
    record(CloseStep.ScratchGated);
  }

  if (step() < CloseStep.TakenOut) {
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
    if (where === 'folder') {
      await folderBack(deps, passId, signal);
      const ran = await deps.ship.gatePassTip({ passId, sha: await tip(), where, signal });
      if (ran.aborted) throw new CloseStoppedError(passId);
      if (!ran.passed) {
        await failGate(deps, closing(), 'folder', ran);
        return;
      }
    }
    record(CloseStep.FolderGated);
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
            id: CLOSE_NOTICE,
            kind: PassNoticeKind.Close,
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
    pass = closing();
    await fastForwardReturn(deps, pass);
    record(CloseStep.FastForwarded);
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
   * Refused (409) while the pass is not open or Your folder is off its branch, and for choices the
   * lists do not allow.
   */
  close(passId: PassId, request: PassCloseRequest): Promise<PassCloseAnswerDto>;
  /** Raises the abort of the pass's close job and waits for it to stop. */
  abort(passId: PassId): Promise<void>;
  /** Start-up: each closing pass goes on from its last step. */
  resume(): void;
}

export function createPassCloses(deps: CloseDeps): PassCloses {
  const db = deps.state.db;
  const running = new Map<PassId, { abort: AbortController; done: Promise<void> }>();

  function run(passId: PassId): void {
    if (running.has(passId)) return;
    const pass = getPass(db, passId);
    const abort = new AbortController();
    const done = new Promise<void>((resolve) => {
      deps.jobs.run(
        jobKey({ projectId: pass.projectId, worktreePath: null }, JobQueue.Cut),
        async (jobSignal) => {
          try {
            await closeSteps(deps, passId, AbortSignal.any([jobSignal, abort.signal]));
            deps.state.write((ctx) => {
              clearPassNotice(ctx, passId, CLOSE_NOTICE);
            });
          } catch (error) {
            if (!(error instanceof CloseStoppedError)) {
              deps.logger.warn({ passId, err: errorText(error) }, 'close did not finish');
              deps.state.write((ctx) => {
                if (getPass(ctx.tx, passId).state !== PassState.Closing) return;
                noticeStuck(ctx, passId, error);
              });
            }
          } finally {
            running.delete(passId);
            resolve();
          }
        },
      );
    });
    running.set(passId, { abort, done });
  }

  return {
    preview: (passId) => closePreview(deps, passId),
    async close(passId, request) {
      const pass = getPass(db, passId);
      if (pass.state !== PassState.Open)
        throw new ConflictError(
          `Pass "${pass.name}" is ${pass.state.toLowerCase()}: only an open pass is closed`,
        );
      const repo = getProject(db, pass.projectId).repoPath;
      const on = await deps.git.currentBranch(repo);
      if (on !== passBranch(db, pass))
        throw new ConflictError(
          `Your folder is on ${on ?? 'a detached HEAD'}, not the pass's branch: switch back before closing`,
        );
      checkCloseRequest(
        await closePreview(deps, passId),
        request,
        new Set(
          listPassTasks(db, passId)
            .filter(
              (t) =>
                t.workstreamId !== null &&
                getWorkstreamRow(db, t.workstreamId).state === WorkstreamState.Done,
            )
            .map((t) => t.id),
        ),
      );
      // D25: the agents stop only now, and the close goes on only on the lists they leave.
      for (const task of unfinishedPages(db, passId))
        if (task.workstreamId !== null) await deps.stopLane(task.workstreamId);
      const now = await closePreview(deps, passId);
      if (now.token !== request.token)
        return { outcome: 'changed', preview: now, changed: closeChanges(request, now) };
      deps.state.write((ctx) => {
        setClosePlan(ctx, passId, request);
        for (const wait of listSignOffWaits(ctx.tx, passId)) deleteSignOffWait(ctx, wait.taskId);
      });
      run(passId);
      return { outcome: 'closing', pass: getPass(db, passId) };
    },
    async abort(passId) {
      const job = running.get(passId);
      if (!job) return;
      job.abort.abort();
      await job.done;
    },
    resume() {
      for (const pass of listPassesIn(db, PassState.Closing)) run(pass.id);
    },
  };
}

/** The header notice of a close that stopped on an error: it goes on at the next start, or Abandon. */
function noticeStuck(ctx: WriteContext, passId: PassId, error: unknown): void {
  setPassNotice(ctx, passId, {
    id: CLOSE_NOTICE,
    kind: PassNoticeKind.Close,
    text: `The close stopped: ${errorText(error)}. It goes on when 10db next starts; Abandon Pass ends it now.`,
    sendable: false,
    cardId: null,
    at: ctx.now,
  });
}
