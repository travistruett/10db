import {
  EventType,
  PASS_MOVE_CHOICE,
  PassId,
  PassMoveReason,
  PassState,
  PullRequestState,
  PassMoveDetail,
  type InboxAnswer,
  type InboxItemDto,
  type PassDto,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  findOpenPass,
  findPass,
  hasAnsweredByFoldKey,
  getBatch,
  getPass,
  getPassProgress,
  getPassPullRequest,
  getProject,
  listBatches,
  listPassesIn,
  settlePass,
  type DbReader,
} from '@10db/db';
import type { EventBus } from '../events';
import { comparablePath, samePath, type SwitchBack } from '../git';
import type { Card } from './cards';
import { networkCall, raise, withdraw, type DeliveryContext } from './context';
import { jobKey, JobQueue } from './jobs';

// Workbench spec §5.3, §5.4, D22, call 29: a pass closed on a pull request project is CLOSED but not
// SETTLED until its work is in the base. When its pull request merges and the base's tree is the
// pass's tip, the folder's branch moves to the base with no file changed and the pass settles. Any
// other way ends at one card, Move <branch> to origin/<base>, which the builder may also take before
// the merge. Nothing is forced.

/** The fold key of a closed pass's one Move card. */
export const passMoveKey = (passId: PassId): string => `pass-move:${passId}`;

/** The pass stacked on this one that is still open or closing (D24): it moves the branch itself. */
function stackedAbove(db: DbReader, pass: PassDto): PassDto | undefined {
  const above = findOpenPass(db, pass.projectId);
  if (above === undefined || above.state === PassState.Abandoning) return undefined;
  return getPassProgress(db, above.id).stackedOn === pass.id ? above : undefined;
}

const SAYS: Readonly<Record<PassMoveReason, string>> = {
  [PassMoveReason.Closed]:
    "has closed and its pull request has not merged yet. Your folder stays on {R}, which holds the pass's work, until it merges; ordinary tasks in the folder run in a copy or wait until then.",
  [PassMoveReason.Drift]:
    'merged, but origin/{B} holds more than the pass did (another pull request reached it first), so 10db did not move {R} by itself.',
  [PassMoveReason.CiFix]:
    'merged with a CI fix pushed to its pull request that your folder never had, so 10db did not move {R} by itself.',
  [PassMoveReason.ClosedUnmerged]:
    "has a pull request that closed without merging. {R} still holds the pass's work.",
};

/** D22's card: Move puts the folder's branch on the base, where the pass's work is once it merges. */
export function moveCard(
  pass: PassDto,
  input: {
    readonly base: string;
    readonly reason: PassMoveReason;
    readonly prUrl: string | null;
    /** Why the last Move was refused, said first; null for none. */
    readonly why: string | null;
  },
): Card {
  const detail: PassMoveDetail = {
    kind: 'pass_move',
    passId: pass.id,
    returnBranch: pass.returnBranch,
    base: input.base,
    reason: input.reason,
    prUrl: input.prUrl,
  };
  const says = SAYS[input.reason]
    .replaceAll('{R}', pass.returnBranch)
    .replaceAll('{B}', input.base);
  const named = input.prUrl === null ? '' : ` (${input.prUrl})`;
  return {
    title: `Move ${pass.returnBranch} to origin/${input.base}`,
    body: [
      ...(input.why === null ? [] : [`10db moved nothing: ${input.why}.`, '']),
      `Workbench pass "${pass.name}"${named} ${says}`,
      '',
      `Move checks out origin/${input.base} on ${pass.returnBranch}, keeping uncommitted changes it does not write, and settles the pass. It is refused while one lies where it writes, and while ${pass.returnBranch} holds a commit of your own.`,
    ].join('\n'),
    foldKey: passMoveKey(pass.id),
    refresh: true,
    detail,
    options: [
      {
        label: PASS_MOVE_CHOICE,
        description: `Moves ${pass.returnBranch} to origin/${input.base}; the pass's work leaves the screen until it is in the base`,
      },
    ],
  };
}

/** How a settle was asked for: with news (a close, a merge or a refused Move), or to look again. */
export interface SettleAsk {
  /** True when what is offered may be new: a card the builder dismissed is raised again. */
  readonly news: boolean;
}

/**
 * Raises the closed pass's Move card, or rewords the one it has, unless a pass stacked on it is open
 * or closing: then the card waits, withdrawn, for that pass's close to move the branch. Looked at
 * again with nothing new (the pull request still open, a restart), a card the builder dismissed
 * stays dismissed.
 */
function offerMove(
  ctx: DeliveryContext,
  pass: PassDto,
  reason: PassMoveReason,
  ask: SettleAsk,
  why: string | null = null,
): void {
  const db = ctx.state.db;
  const key = passMoveKey(pass.id);
  if (stackedAbove(db, pass) !== undefined) {
    withdraw(ctx.state, ctx.inbox, pass.projectId, [key]);
    return;
  }
  const news = ask.news || why !== null;
  if (
    !news &&
    findOpenByFoldKey(db, pass.projectId, key) === undefined &&
    hasAnsweredByFoldKey(db, pass.projectId, key)
  )
    return;
  const batch = getBatch(db, pass.batchId);
  raise(
    ctx.inbox,
    pass.projectId,
    moveCard(pass, { base: batch.baseBranch, reason, prUrl: batch.prUrl, why }),
  );
}

/** Whether `branch` is checked out in a worktree other than the folder itself. */
async function elsewhere(ctx: DeliveryContext, repo: string, branch: string): Promise<boolean> {
  return (await ctx.git.listWorktrees(repo)).some(
    (e) => e.branch === branch && !samePath(comparablePath(e.path), comparablePath(repo)),
  );
}

function settled(ctx: DeliveryContext, pass: PassDto, how: 'realigned' | 'moved'): void {
  ctx.state.write((w) => settlePass(w, pass.id, how));
  withdraw(ctx.state, ctx.inbox, pass.projectId, [passMoveKey(pass.id)]);
  ctx.logger.info({ passId: pass.id, how }, 'pass settled');
}

/**
 * A closed pass after a read of its pull request: merged with the base's tree its tip, it realigns
 * (the return branch moves to the base by compare-and-swap while it is at the tip, HEAD names it and
 * no other worktree has it) and settles; anything else leaves, or rewords, its Move card.
 */
export async function settleClosedPass(
  ctx: DeliveryContext,
  passId: PassId,
  signal: AbortSignal,
  ask: SettleAsk = { news: false },
): Promise<void> {
  const db = ctx.state.db;
  const pass = getPass(db, passId);
  if (pass.state !== PassState.Closed) return;
  if (stackedAbove(db, pass) !== undefined) {
    withdraw(ctx.state, ctx.inbox, pass.projectId, [passMoveKey(pass.id)]);
    return;
  }
  const pr = getPassPullRequest(db, passId);
  if (pr?.state === PullRequestState.Closed) {
    offerMove(ctx, pass, PassMoveReason.ClosedUnmerged, ask);
    return;
  }
  if (pr?.state !== PullRequestState.Merged) {
    offerMove(ctx, pass, PassMoveReason.Closed, ask);
    return;
  }
  const batch = getBatch(db, pass.batchId);
  const repo = getProject(db, pass.projectId).repoPath;
  const branch = batch.branch;
  if (branch === null) return;
  await ctx.git.fetch(repo, batch.baseBranch, networkCall(ctx, signal));
  const base = await ctx.git.trackingTip(repo, batch.baseBranch);
  const tip = await ctx.git.branchTip(repo, branch);
  const at = await ctx.git.branchTip(repo, pass.returnBranch);
  if (base === null || tip === null || at === null) {
    offerMove(ctx, pass, PassMoveReason.Drift, ask);
    return;
  }
  const same = (await ctx.git.filesChangedBetween(repo, base, tip)).length === 0;
  const fixed = listBatches(db, { projectId: pass.projectId }).some((b) => b.ciFixOf === batch.id);
  if (!same) {
    offerMove(ctx, pass, fixed ? PassMoveReason.CiFix : PassMoveReason.Drift, ask);
    return;
  }
  // A rerun after the move: the branch is on the base already.
  if (at === base) {
    settled(ctx, pass, 'realigned');
    return;
  }
  const here = (await ctx.git.currentBranch(repo)) === pass.returnBranch;
  if (at !== tip || !here || (await elsewhere(ctx, repo, pass.returnBranch))) {
    offerMove(ctx, pass, PassMoveReason.Drift, ask);
    return;
  }
  const moved = await ctx.git.moveBranchCas({
    repo,
    branch: pass.returnBranch,
    to: base,
    expect: tip,
  });
  if (moved === 'raced') {
    offerMove(ctx, pass, PassMoveReason.Drift, ask);
    return;
  }
  settled(ctx, pass, 'realigned');
}

/** Why a move left the folder as it was, in words. */
function refusalOf(outcome: Exclude<SwitchBack, { kind: 'switched' }>, branch: string): string {
  switch (outcome.kind) {
    case 'moved':
      return outcome.found === branch
        ? `${branch} moved meanwhile`
        : `the folder is on ${outcome.found ?? 'a detached HEAD'}, not ${branch}`;
    case 'dirty':
      return `uncommitted changes lie where the move writes: ${outcome.paths.join(', ')}`;
    case 'gone':
      return 'the base is gone';
    case 'checked_out':
      return `${branch} is checked out in ${outcome.path}`;
    case 'ignored':
      return `files git does not track lie where the move writes: ${outcome.paths.join(', ')}`;
  }
}

/**
 * The Move card's answer (D22, call 29): the closed pass's return branch, which HEAD names, moves to
 * the fetched base with its files following, as the built switch writes them, and the pass settles.
 * Refused, with the card reworded to say why, while an uncommitted change lies where it writes or
 * the branch holds a commit that is neither on the base nor on the pass's pushed branch.
 */
export async function movePassBranch(
  ctx: DeliveryContext,
  passId: PassId,
  signal: AbortSignal,
): Promise<void> {
  const db = ctx.state.db;
  const pass = getPass(db, passId);
  if (pass.state !== PassState.Closed) {
    withdraw(ctx.state, ctx.inbox, pass.projectId, [passMoveKey(pass.id)]);
    return;
  }
  const batch = getBatch(db, pass.batchId);
  const repo = getProject(db, pass.projectId).repoPath;
  const pr = getPassPullRequest(db, passId);
  const reason =
    pr?.state === PullRequestState.Closed
      ? PassMoveReason.ClosedUnmerged
      : pr?.state === PullRequestState.Merged
        ? PassMoveReason.Drift
        : PassMoveReason.Closed;
  const refuse = (why: string): void => {
    offerMove(ctx, pass, reason, { news: true }, why);
  };
  await ctx.git.fetch(repo, batch.baseBranch, networkCall(ctx, signal));
  const base = await ctx.git.trackingTip(repo, batch.baseBranch);
  const at = await ctx.git.branchTip(repo, pass.returnBranch);
  if (base === null || at === null) {
    refuse(`origin/${batch.baseBranch} or ${pass.returnBranch} cannot be read`);
    return;
  }
  const pushed = batch.branch === null ? null : await ctx.git.trackingTip(repo, batch.branch);
  const own: string[] = [];
  for (const sha of await ctx.git.ownCommitsSince(repo, base, at))
    if (pushed === null || !(await ctx.git.isAncestor(repo, sha, pushed))) own.push(sha);
  if (own.length > 0) {
    refuse(
      `${pass.returnBranch} holds ${String(own.length)} commit${own.length === 1 ? '' : 's'} of your own that neither origin/${batch.baseBranch} nor the pass's pushed branch has (${own.map((s) => s.slice(0, 7)).join(', ')}), which the move would drop`,
    );
    return;
  }
  const outcome = await ctx.git.moveCheckedOutBranch({
    repo,
    branch: pass.returnBranch,
    from: at,
    to: base,
  });
  if (outcome.kind !== 'switched') {
    refuse(refusalOf(outcome, pass.returnBranch));
    return;
  }
  settled(ctx, pass, 'moved');
}

/** Runs `step` for the pass in its project's delivery queue, so it never races a sign-off or a close. */
export function queuePassSettle(
  ctx: DeliveryContext,
  passId: PassId,
  step: (ctx: DeliveryContext, passId: PassId, signal: AbortSignal) => Promise<void>,
): void {
  const pass = findPass(ctx.state.db, passId);
  if (pass === undefined) return;
  ctx.jobs.run(
    jobKey({ projectId: pass.projectId, worktreePath: null }, JobQueue.Ship),
    async (signal) => {
      if (signal.aborted) return;
      try {
        await step(ctx, passId, signal);
      } catch (error) {
        ctx.logger.warn(
          { passId, err: error instanceof Error ? error.message : String(error) },
          'closed pass not settled',
        );
      }
    },
  );
}

/**
 * Follows a pass's close and Abandon: a pass that closes unsettled gets its Move card at once, and
 * when a pass stacked on a closed one is abandoned, the closed one's card and realignment resume.
 */
export function subscribePassSettles(bus: EventBus, ctx: DeliveryContext): () => void {
  return bus.subscribe((event) => {
    if (event.type !== EventType.PassClosed && event.type !== EventType.PassChanged) return;
    const id = PassId.safeParse(event.entityId);
    if (!id.success) return;
    const pass = findPass(ctx.state.db, id.data);
    if (event.type === EventType.PassClosed) {
      if (pass?.state === PassState.Closed)
        queuePassSettle(ctx, pass.id, (c, id, signal) =>
          settleClosedPass(c, id, signal, { news: true }),
        );
      return;
    }
    if (pass?.state !== PassState.Abandoned || event.data['state'] !== PassState.Abandoned) return;
    const below = getPassProgress(ctx.state.db, pass.id).stackedOn;
    if (below !== null)
      queuePassSettle(ctx, below, (c, id, signal) =>
        settleClosedPass(c, id, signal, { news: true }),
      );
  });
}

/** At start-up: each closed pass is looked at again, its card raised once and its merge followed. */
export function resumePassSettles(ctx: DeliveryContext): void {
  for (const pass of listPassesIn(ctx.state.db, PassState.Closed))
    queuePassSettle(ctx, pass.id, settleClosedPass);
}

/** Acts on an answer to a closed pass's Move card, in its project's delivery queue; other cards pass by. */
export function answerPassMoveCard(
  ctx: DeliveryContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): void {
  // The detail is JSON read back from the database: a boundary, so parse it.
  const detail = PassMoveDetail.safeParse(item.detail);
  if (!detail.success || answer.choice !== PASS_MOVE_CHOICE) return;
  queuePassSettle(ctx, detail.data.passId, movePassBranch);
}
