import {
  ConflictError,
  EventType,
  InboxKind,
  InboxState,
  PASS_SIGN_OFF_CHOICE,
  PassState,
  WorkstreamState as S,
  type PassDto,
  type PassHoldDto,
  type PassId,
  type PassSignOffDto,
  type TaskId,
  type WorkstreamId,
  type WorkstreamState,
} from '@10db/contracts';
import {
  clearLease,
  deleteSignOffWait,
  getInboxItem,
  getPass,
  getProject,
  getSharedChange,
  getTask,
  getWorkstreamRow,
  insertSignOffWait,
  insertSystemNotice,
  latestPassTurn,
  listPassTurns,
  listSignOffWaits,
  listTaskThreadRows,
  markPassTurnAnswered,
  passHoldingTask,
  releaseClaims,
  setTaskStatus,
  transitionWorkstream,
  updateInboxItem,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { jobKey, JobQueue } from '../delivery';
import type { EventBus } from '../events';
import { foldHandEdits } from './hand-edits';
import { pageMatcher, passBranch, passKeptRef, readKeptRef, type PassWorkDeps } from './kept-work';
import {
  closeHoldsOf,
  keepHold,
  landSharedChanges,
  sharedNeeded,
  type LandedShared,
} from './shared-chain';
import type { StopPassLane } from './take-out';

// Workbench spec §9.2: Sign Off ends the page's session, then lands, in one critical section under
// the project's delivery key, the shared changes the page needs in chain order and the page's own
// files as one commit, and ends the page's run in one write. A sign-off that needs a hold still open
// in another page's turn waits on a row, so a restart finds it.

/** Who asked for a sign-off. */
export const SignOffFrom = {
  /** The builder, on a Ready page: its route, or Sign Off on its `check` item. */
  Page: 'page',
  /** A sign-off that waited for another page's hold: it goes on only while its wait row stands. */
  Wait: 'wait',
  /** A close's Sign Off Now: the pass is closing, and the page may be in any state. */
  Close: 'close',
} as const;
export type SignOffFrom = (typeof SignOffFrom)[keyof typeof SignOffFrom];

export interface SignOffInput {
  readonly taskId: TaskId;
  readonly from: SignOffFrom;
}

/** What a sign-off did. */
export type SignOffOutcome =
  | {
      readonly kind: 'signed_off';
      /** The page's commit; null when it had no file to land. */
      readonly landedSha: string | null;
      readonly files: readonly string[];
      /** The chain numbers this sign-off landed, its own and the ones it needed. */
      readonly sharedLanded: readonly number[];
    }
  | { readonly kind: 'waiting'; readonly waitsFor: PassHoldDto }
  | { readonly kind: 'not_now'; readonly reason: string };

/** What a sign-off needs: the pass's work in the folder and the runner's stop. */
export type SignOffDeps = PassWorkDeps & { readonly stopLane: StopPassLane };

/**
 * The run's path to DONE once step 0 has stopped it (spec §9.2), by the edges that exist, since none
 * goes there straight from most states; null where a sign-off cannot follow (a turn running again,
 * the builder at the keyboard, or a run that ended otherwise). DONE itself needs nothing more.
 */
export function signOffPath(state: WorkstreamState): readonly WorkstreamState[] | null {
  switch (state) {
    case S.WaitingHuman:
      return [S.Verifying, S.Done];
    case S.Queued:
      return [S.Starting, S.Verifying, S.Done];
    case S.Held:
    case S.PausedLimit:
    case S.Recovering:
      return [S.Queued, S.Starting, S.Verifying, S.Done];
    case S.Starting:
      return [S.Verifying, S.Done];
    case S.Verifying:
      return [S.Done];
    case S.Done:
      return [];
    case S.Running:
    case S.HandingOff:
    case S.TakenOver:
    case S.Failed:
    case S.Cancelled:
      return null;
  }
}

/**
 * Whether the run waits on the builder with the page Ready: its `check` item is open, or, for a
 * sign-off already asked, closed by its own Sign Off (the card closes with that answer).
 */
function isReady(db: DbReader, id: WorkstreamId, asked = false): boolean {
  const row = getWorkstreamRow(db, id);
  if (row.state !== S.WaitingHuman || row.nextAction.kind !== 'pass_review') return false;
  const item = getInboxItem(db, row.nextAction.inboxId);
  if (item.kind !== InboxKind.Check) return false;
  return (
    item.state === InboxState.Open ||
    (asked && item.state === InboxState.Resolved && item.answer?.choice === PASS_SIGN_OFF_CHOICE)
  );
}

/**
 * Why the builder's Sign Off on the page is refused now, or null: the pass must be open, hold the
 * page, and the page be Ready. The route and the check item's answer both ask it.
 */
export function signOffRefusal(db: DbReader, passId: PassId, taskId: TaskId): string | null {
  const pass = getPass(db, passId);
  const task = getTask(db, taskId);
  if (pass.state !== PassState.Open)
    return `Pass "${pass.name}" is ${pass.state.toLowerCase()}: a page is signed off only while it is open`;
  if (passHoldingTask(db, task)?.id !== passId)
    return `${task.title} is not a page of pass "${pass.name}"`;
  if (task.workstreamId === null || !isReady(db, task.workstreamId))
    return `${task.title} is not Ready: a page is signed off once its turn has ended`;
  return null;
}

/** The open holds of other pages that the page needs before it can land. */
function othersNeeded(db: DbReader, passId: PassId, taskId: TaskId): PassHoldDto[] {
  return sharedNeeded(db, passId, taskId).openHolds.filter((h) => h.taskId !== taskId);
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Starts the builder's Sign Off on a Ready page as a job under the project's delivery key, and
 * answers what it will do: land now, or wait for another page's turn that holds a shared change the
 * page needs. A page already waiting answers its wait and starts nothing more. The caller has asked
 * `signOffRefusal` first.
 */
export function startSignOff(deps: SignOffDeps, taskId: TaskId): PassSignOffDto {
  const db = deps.state.db;
  const task = getTask(db, taskId);
  const waitingFor = (holder: TaskId): PassSignOffDto => ({
    taskId,
    state: 'waiting',
    waitsFor: { taskId: holder, title: getTask(db, holder).title },
  });
  const wait = listSignOffWaits(db).find((w) => w.taskId === taskId);
  if (wait) return waitingFor(wait.waitsForTaskId);
  if (task.passId == null) throw new ConflictError(`${task.title} is in no pass`);
  signOff(deps, { taskId, from: SignOffFrom.Page }).catch((error: unknown) => {
    deps.logger.warn({ taskId, err: errorText(error) }, 'sign-off failed');
  });
  const holder = othersNeeded(db, task.passId, taskId)[0];
  return holder === undefined
    ? { taskId, state: 'signing_off', waitsFor: null }
    : waitingFor(holder.taskId);
}

/**
 * The builder's Sign Off on a page (`POST /passes/:passId/tasks/:taskId/sign-off`): refused with a
 * ConflictError (409) by `signOffRefusal`, else started (`startSignOff`).
 */
export function askSignOff(deps: SignOffDeps, passId: PassId, taskId: TaskId): PassSignOffDto {
  const refused = signOffRefusal(deps.state.db, passId, taskId);
  if (refused !== null) throw new ConflictError(refused);
  return startSignOff(deps, taskId);
}

/** Cancels the page's waiting sign-off (`DELETE .../sign-off`); refused when it is not waiting. */
export function cancelSignOffWait(deps: PassWorkDeps, passId: PassId, taskId: TaskId): void {
  deps.state.write((ctx) => {
    const task = getTask(ctx.tx, taskId);
    const wait = listSignOffWaits(ctx.tx, passId).find((w) => w.taskId === taskId);
    if (!wait || !deleteSignOffWait(ctx, taskId))
      throw new ConflictError(`${task.title} has no sign-off waiting`);
    insertSystemNotice(ctx, taskId, 'Sign-off cancelled while it waited.');
  });
}

/** The commit message of a page's sign-off (spec §9.2, call 10): its title, each turn's first line. */
function signOffMessage(db: DbReader, pass: PassDto, taskId: TaskId): string {
  const task = getTask(db, taskId);
  const turns = new Set(
    listPassTurns(db, pass.id)
      .filter((t) => t.taskId === taskId)
      .map((t) => t.id),
  );
  const lines = listTaskThreadRows(db, taskId)
    .filter((m) => m.kind === 'reply' && m.turnId !== null && turns.has(m.turnId))
    .map((m) => m.body.trim().split('\n')[0]?.trim() ?? '')
    .filter((line) => line !== '');
  const body = lines.map((line) => `- ${line}`).join('\n');
  return `${task.title}\n\n${body === '' ? '' : `${body}\n\n`}10db-task: ${taskId}\n`;
}

const fileCount = (n: number): string => `${String(n)} file${n === 1 ? '' : 's'}`;
const quoted = (paths: readonly string[]): string => paths.map((p) => `\`${p}\``).join(', ');

/**
 * Step 5 of a sign-off, in one write: the page's `check` item resolved, its last turn answered, its
 * wait row gone, the run moved to DONE by `signOffPath` (which releases the page), the thread lines
 * and `pass.page_signed_off`. Refused, writing nothing, for a run no sign-off can follow.
 */
export function finishSignOff(
  ctx: WriteContext,
  input: {
    readonly passId: PassId;
    readonly taskId: TaskId;
    readonly workstreamId: WorkstreamId;
    readonly landedSha: string | null;
    readonly files: readonly string[];
    readonly shared: readonly LandedShared[];
    readonly indexStale: boolean;
  },
): void {
  const row = getWorkstreamRow(ctx.tx, input.workstreamId);
  const path = signOffPath(row.state);
  if (path === null)
    throw new ConflictError(
      `${getTask(ctx.tx, input.taskId).title} is ${row.state.toLowerCase()}: it cannot be signed off now`,
    );
  if (row.nextAction.kind === 'pass_review') {
    const item = getInboxItem(ctx.tx, row.nextAction.inboxId);
    if (item.state === InboxState.Open)
      updateInboxItem(ctx, item.id, {
        state: InboxState.Resolved,
        ...(item.kind === InboxKind.Check ? { answer: { choice: PASS_SIGN_OFF_CHOICE } } : {}),
      });
  }
  const turn = latestPassTurn(ctx.tx, input.taskId);
  if (turn?.endedAt != null) markPassTurnAnswered(ctx, turn.id);
  deleteSignOffWait(ctx, input.taskId);
  for (const to of path)
    transitionWorkstream(ctx, input.workstreamId, {
      to,
      fence: null,
      ...(to === S.Done ? { patch: { currentSessionId: null } } : {}),
      reason: 'the builder signed off the page',
    });
  if (path.length > 0) {
    setTaskStatus(ctx, input.taskId, 'done');
    releaseClaims(ctx, input.workstreamId);
    clearLease(ctx, input.workstreamId);
  }
  const title = getTask(ctx.tx, input.taskId).title;
  // A change an earlier page made while it is still open landed early: its thread says with what.
  for (const landed of input.shared) {
    if (landed.landedSha === null) continue;
    const change = getSharedChange(ctx.tx, input.passId, landed.seq);
    if (change.taskId === input.taskId) continue;
    const owner = getTask(ctx.tx, change.taskId);
    if (
      owner.workstreamId !== null &&
      getWorkstreamRow(ctx.tx, owner.workstreamId).state === S.Done
    )
      continue;
    insertSystemNotice(
      ctx,
      change.taskId,
      `Landed ${owner.title}'s change to ${quoted(change.paths)} with ${title}, which builds on it.`,
    );
  }
  insertSystemNotice(
    ctx,
    input.taskId,
    input.landedSha === null
      ? 'Signed off · nothing to land'
      : `Signed off · landed as \`${input.landedSha.slice(0, 7)}\` · ${fileCount(input.files.length)}`,
  );
  if (input.indexStale)
    insertSystemNotice(
      ctx,
      input.taskId,
      "Another git held Your folder's index as the page landed, so `git status` may show its files as changed until that git is done. Don't commit them by hand: they are on the pass's branch.",
    );
  ctx.emit({
    type: EventType.PassPageSignedOff,
    entityType: 'pass',
    entityId: input.passId,
    data: {
      passId: input.passId,
      taskId: input.taskId,
      landedSha: input.landedSha,
      files: [...input.files],
      sharedLanded: input.shared.filter((s) => s.landedSha !== null).map((s) => s.seq),
    },
  });
}

/**
 * A sign-off's steps (spec §9.2) for a caller already holding the project's delivery key: a close,
 * or the job `signOff` runs. Each run checks the pass and the page again and reruns step 0, so a job
 * queued behind others, re-enqueued after a wait, or rerun after a restart acts on the rows as they
 * are. 0 stops the page's session and keeps what its turn left; a hold the page needs that another
 * page's turn holds makes it wait (a row, and the job ends), except in a close, whose turns have all
 * stopped, which keeps it. Then 1 folds the builder's hand edits; 2 lands the shared changes the page
 * needs, in chain order; 3 lands the page's files as one commit; 4 the folder's index follows; 5 one
 * write ends the run. Every commit has its own operation id, so a rerun makes only what is missing.
 */
export async function signOffSteps(
  deps: SignOffDeps,
  input: SignOffInput,
): Promise<SignOffOutcome> {
  const db = deps.state.db;
  const task = getTask(db, input.taskId);
  const pass = task.passId == null ? undefined : passHoldingTask(db, task);
  const ws = task.workstreamId;
  const notNow = (reason: string): SignOffOutcome => {
    if (input.from === SignOffFrom.Close) throw new ConflictError(reason);
    deps.state.write((ctx) => {
      deleteSignOffWait(ctx, task.id);
      insertSystemNotice(ctx, task.id, `Not signed off: ${reason}.`);
    });
    return { kind: 'not_now', reason };
  };
  if (pass === undefined || ws === null) return notNow(`${task.title} is in no pass`);
  if (input.from === SignOffFrom.Wait && !listSignOffWaits(db).some((w) => w.taskId === task.id))
    return { kind: 'not_now', reason: 'the sign-off no longer waits' };
  const wanted = input.from === SignOffFrom.Close ? PassState.Closing : PassState.Open;
  if (pass.state !== wanted) return notNow(`the pass is ${pass.state.toLowerCase()}`);
  if (getWorkstreamRow(db, ws).state === S.Done)
    return { kind: 'signed_off', landedSha: null, files: [], sharedLanded: [] };
  if (input.from !== SignOffFrom.Close && !isReady(db, ws, true))
    return notNow('the page is no longer Ready');

  // Step 0: the page's session ends, and what its turn left is kept, its own holds with it.
  await deps.stopLane(ws);
  await closeHoldsOf(deps, ws);
  const others = othersNeeded(db, pass.id, task.id);
  if (others.length > 0 && input.from !== SignOffFrom.Close) {
    const hold = others[0];
    if (hold === undefined) throw new ConflictError('No hold to wait for');
    deps.state.write((ctx) => {
      const wait = listSignOffWaits(ctx.tx, pass.id).find((w) => w.taskId === task.id);
      if (wait?.waitsFor === hold.claimId) return;
      deleteSignOffWait(ctx, task.id);
      insertSignOffWait(ctx, { taskId: task.id, passId: pass.id, waitsFor: hold.claimId });
    });
    return { kind: 'waiting', waitsFor: hold };
  }
  // A close stopped every turn: a hold still open is kept now, so its change can land.
  for (const hold of others) await keepHold(deps, { claimId: hold.claimId });
  const state = getWorkstreamRow(db, ws).state;
  if (signOffPath(state) === null)
    throw new ConflictError(`${task.title} is ${state.toLowerCase()}: it cannot be signed off now`);

  // Steps 1 to 4, in order: the hand edits, the chain's prefix, then the page's own commit.
  await foldHandEdits(deps, { workstreamId: ws });
  const shared = await landSharedChanges(deps, {
    passId: pass.id,
    upTo: sharedNeeded(db, pass.id, task.id).upTo,
  });
  const repo = getProject(db, pass.projectId).repoPath;
  const branch = passBranch(db, pass);
  const kept = await readKeptRef(deps.git, repo, passKeptRef(pass.id, task.id));
  let landedSha: string | null = null;
  let files: readonly string[] = [];
  let indexStale = false;
  if (kept !== null) {
    const tip = await deps.git.commitAt(repo, branch);
    const mine = pageMatcher(db, getProject(db, pass.projectId), getTask(db, task.id), pass.id);
    const paths = (await deps.git.filesChangedBetween(repo, tip, kept)).filter(mine);
    const landed = await deps.git.landPaths({
      repo,
      branch,
      from: kept,
      paths,
      message: signOffMessage(db, pass, task.id),
      opId: `pass:${pass.id}:sign-off:${ws}`,
    });
    landedSha = landed.sha;
    indexStale = landed.indexStale;
    if (landed.sha !== null)
      files = await deps.git.filesChangedBetween(repo, `${landed.sha}^`, landed.sha);
  }

  const at = landedSha;
  deps.state.write((ctx) => {
    finishSignOff(ctx, {
      passId: pass.id,
      taskId: task.id,
      workstreamId: ws,
      landedSha: at,
      files,
      shared,
      indexStale,
    });
  });
  // A question the stopped turn left open is about work that is done now.
  deps.inbox.cancelForWorkstream(ws);
  return {
    kind: 'signed_off',
    landedSha,
    files,
    sharedLanded: shared.filter((s) => s.landedSha !== null).map((s) => s.seq),
  };
}

/** Signs a page off as a job under the project's delivery key, as a take-out runs. */
export function signOff(deps: SignOffDeps, input: SignOffInput): Promise<SignOffOutcome> {
  const task = getTask(deps.state.db, input.taskId);
  return new Promise<SignOffOutcome>((resolve, reject) => {
    deps.jobs.run(
      jobKey({ projectId: task.projectId, worktreePath: null }, JobQueue.Cut),
      async () => {
        try {
          resolve(await signOffSteps(deps, input));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  });
}

/** Queues again every sign-off that waits on a hold now closed (spec §9.2, §12). */
export function resumeSignOffWaits(deps: SignOffDeps, passId?: PassId): void {
  const db = deps.state.db;
  for (const wait of listSignOffWaits(db, passId)) {
    const pass = getPass(db, wait.passId);
    if (pass.state !== PassState.Open) continue;
    signOff(deps, { taskId: wait.taskId, from: SignOffFrom.Wait }).catch((error: unknown) => {
      deps.logger.warn({ taskId: wait.taskId, err: errorText(error) }, 'waiting sign-off failed');
    });
  }
}

/**
 * Goes on with a waiting sign-off once the hold it waits for closes: a closed hold appends
 * `pass.changed` naming it. Returns the function that ends the subscription.
 */
export function subscribeSignOffWaits(bus: EventBus, deps: SignOffDeps): () => void {
  return bus.subscribe((event) => {
    if (event.type !== EventType.PassChanged || event.data['closed'] !== 1) return;
    const waits = listSignOffWaits(deps.state.db).filter((w) => w.passId === event.entityId);
    if (waits.length === 0) return;
    const passId = waits[0]?.passId;
    if (passId !== undefined) resumeSignOffWaits(deps, passId);
  });
}
