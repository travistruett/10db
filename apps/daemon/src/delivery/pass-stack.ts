import {
  Delivery,
  InboxState,
  PASS_RETARGET_CHOICE,
  PassNoticeKind,
  PassRetargetDetail,
  PassState,
  PullRequestState,
  type InboxAnswer,
  type InboxItemDto,
  type PassDto,
  type PassId,
  type ProjectId,
} from '@10db/contracts';
import {
  clearPassNotice,
  findOpenByFoldKey,
  hasAnsweredByFoldKey,
  getBatch,
  getPass,
  getPassProgress,
  getPassPullRequest,
  getProject,
  listInbox,
  listPassesIn,
  setPassNotice,
  setStackedOn,
  settlePass,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { Card } from './cards';
import { ghCall, networkCall, raise, withdraw, type DeliveryContext } from './context';
import { pushBranch } from './ship';

// Workbench spec §5.3, D24, calls 34 and 35: a pass may open on a pass that has closed and not
// settled, and stacks on it: the same return branch, its start at the closed pass's tip, its pull
// request based on the closed pass's branch while that one's is open. The closed pass's Move card
// and realignment wait while the stacked pass is open or closing.

/** The fold key of a closed pass's one Move card. */
export const passMoveKey = (passId: PassId): string => `pass-move:${passId}`;

/** The fold key of a stacked pass's Retarget card. */
export const passRetargetKey = (passId: PassId): string => `pass-retarget:${passId}`;

/** The header notice of a stacked pass about the pass below it. */
const STACK_NOTICE = 'stack';

/**
 * The pass stacked on this one while it still holds the folder: open, closing, or closed and not
 * yet settled (D24). It moves the branch at its own close, and its pull request is retargeted when
 * this one merges, whichever of those it is in.
 */
export function stackedAbove(db: DbReader, pass: PassDto): PassDto | undefined {
  for (const state of [PassState.Open, PassState.Closing, PassState.Closed])
    for (const above of listPassesIn(db, state))
      if (above.id !== pass.id && getPassProgress(db, above.id).stackedOn === pass.id) return above;
  return undefined;
}

/** Whether the pass's pull request is there and has neither merged nor closed. */
function unmergedPr(db: DbReader, passId: PassId): boolean {
  const pr = getPassPullRequest(db, passId);
  return (
    pr !== null && pr.state !== PullRequestState.Merged && pr.state !== PullRequestState.Closed
  );
}

/**
 * The pass a new one in the project stacks on. On a pull request project (D24), the newest pass that
 * has closed and not settled, whose tip is where the folder's return branch was left. On a `local`
 * project every pass settles at its close and the new one continues on the same branch (spec §5.3):
 * it stacks on the newest settled pass while that one's record pull request is unmerged, only so its
 * own record pull request takes that pass's branch as its base.
 */
function passBelow(db: DbReader, projectId: ProjectId, opening?: PassId): PassDto | undefined {
  const others = (state: PassState) =>
    listPassesIn(db, state).filter((p) => p.projectId === projectId && p.id !== opening);
  if (getProject(db, projectId).delivery === Delivery.PullRequest)
    return others(PassState.Closed).at(-1);
  const newest = others(PassState.Settled).at(-1);
  return newest !== undefined && unmergedPr(db, newest.id) ? newest : undefined;
}

/**
 * Read before the write that opens a pass at `startSha`: the pass it will stack on (`passBelow`), or
 * null. On a `local` project only one whose branch's tip `startSha` holds: a folder whose branch was
 * moved off that pass carries none of its work, and its record pull request is no base for this one.
 */
export async function stackTarget(
  ctx: Pick<DeliveryContext, 'state' | 'git'>,
  projectId: ProjectId,
  startSha: string,
): Promise<PassId | null> {
  const db = ctx.state.db;
  const below = passBelow(db, projectId);
  if (below === undefined) return null;
  const project = getProject(db, projectId);
  if (project.delivery === Delivery.PullRequest) return below.id;
  const branch = getBatch(db, below.batchId).branch;
  const tip = branch === null ? null : await ctx.git.branchTip(project.repoPath, branch);
  return tip !== null && (await ctx.git.isAncestor(project.repoPath, tip, startSha))
    ? below.id
    : null;
}

/**
 * In the write that opens pass `passId`: the pass it stacks on, `target` from `stackTarget` while it
 * is still the one `passBelow` names, recorded as `stacked_on`; that pass's Move card waits while the
 * new one is open (`subscribePassSettles`). Answers that pass, or undefined.
 */
export function stackOn(
  w: WriteContext,
  passId: PassId,
  target: PassId | null,
): PassDto | undefined {
  const below = passBelow(w.tx, getPass(w.tx, passId).projectId, passId);
  if (below?.id !== target) return undefined;
  setStackedOn(w, passId, below.id);
  return below;
}

/**
 * Bases the stacked pass's pull request on the project's base, unless it is there already or the
 * pass has none yet. Answers whether it has one.
 */
async function retarget(
  ctx: DeliveryContext,
  above: PassDto,
  signal: AbortSignal,
): Promise<boolean> {
  const batch = getBatch(ctx.state.db, above.batchId);
  const pr = getPassPullRequest(ctx.state.db, above.id);
  if (pr === null || batch.repo === null) return false;
  const call = ghCall(ctx, signal);
  const seen = await ctx.gh.prView({ repo: batch.repo, ref: pr.url }, call);
  if (seen?.baseRef !== batch.baseBranch)
    await ctx.gh.prEditBase({ repo: batch.repo, url: pr.url, base: batch.baseBranch }, call);
  return true;
}

/**
 * The pass below a stacked one merged (D24): its work is in the base, and the branch's alignment is
 * the stacked pass's to do. The stacked pass's pull request is based on the base; with the base's
 * tree the merged pass's tip, the base comes into the stacked branch by one merge commit that changes
 * no file, pushed if the branch was, so its pull request keeps showing its own work; otherwise its
 * header says its pull request lists both passes' commits. The merged pass settles last, and each
 * step first checks whether it is done, so a restart between them runs them again and does nothing
 * twice.
 */
export async function followStackedMerge(
  ctx: DeliveryContext,
  below: PassDto,
  above: PassDto,
  signal: AbortSignal,
): Promise<void> {
  const db = ctx.state.db;
  await retarget(ctx, above, signal);
  const project = getProject(db, above.projectId);
  const batch = getBatch(db, above.batchId);
  const lower = getBatch(db, below.batchId).branch;
  if (batch.branch !== null && lower !== null) {
    await ctx.git.fetch(project.repoPath, batch.baseBranch, networkCall(ctx, signal));
    const base = await ctx.git.trackingTip(project.repoPath, batch.baseBranch);
    // The base holds the pass below as it merged: its tip, or, when pages were signed off after its
    // last push (they ride this pass), the tip it pushed.
    const lowerTips = [
      await ctx.git.branchTip(project.repoPath, lower),
      await ctx.git.trackingTip(project.repoPath, lower),
    ];
    let same = false;
    for (const tip of lowerTips)
      if (base !== null && tip !== null && !same)
        same = (await ctx.git.filesChangedBetween(project.repoPath, base, tip)).length === 0;
    if (same && base !== null) await takeBase(ctx, above, below, base, signal);
    else
      ctx.state.write((w) => {
        setPassNotice(w, above.id, {
          id: STACK_NOTICE,
          kind: PassNoticeKind.StackMerged,
          text: `Pass "${below.name}", which this pass is built on, merged into ${batch.baseBranch} with other changes, so this pull request lists that pass's commits beside its own.`,
          sendable: false,
          cardId: null,
          at: w.now,
        });
      });
  }
  ctx.state.write((w) => settlePass(w, below.id, 'realigned'));
  withdraw(ctx.state, ctx.inbox, below.projectId, [passMoveKey(below.id)]);
}

/** Brings `base` into the stacked pass's branch by a merge that keeps its tree, and pushes it if it was. */
async function takeBase(
  ctx: DeliveryContext,
  above: PassDto,
  below: PassDto,
  base: string,
  signal: AbortSignal,
): Promise<void> {
  const project = getProject(ctx.state.db, above.projectId);
  const batch = getBatch(ctx.state.db, above.batchId);
  const branch = batch.branch;
  if (branch === null) return;
  const before = await ctx.git.branchTip(project.repoPath, branch);
  const merged = await ctx.git.mergeKeepingTree({
    repo: project.repoPath,
    branch,
    theirs: base,
    message: `Merge ${batch.baseBranch}, which holds pass "${below.name}", into ${branch}`,
  });
  // A stacked pass that has closed left its return branch at its tip: the branch follows the merge,
  // whose tree is the same, so its realignment still finds it at the tip. A rerun after a crash
  // between the two finds the branch merged already: only a merge whose second parent is the base,
  // as 10db's is, is followed, from its first parent. Not while a pass is stacked on the closed one:
  // that pass's close moves the return branch from its own start, which is this tip.
  if (above.state === PassState.Closed && stackedAbove(ctx.state.db, above) === undefined) {
    const parent = (n: 1 | 2) =>
      ctx.git.commitAt(project.repoPath, `${merged.sha}^${String(n)}`).catch(() => null);
    const from =
      merged.kind === 'merged' ? before : (await parent(2)) === base ? await parent(1) : null;
    if (from !== null)
      await ctx.git.moveBranchCas({
        repo: project.repoPath,
        branch: above.returnBranch,
        to: merged.sha,
        expect: from,
      });
  }
  const pushed = await ctx.git.trackingTip(project.repoPath, branch);
  if (pushed !== null && pushed !== merged.sha)
    await pushBranch(ctx, batch, project, branch, signal);
  ctx.logger.info(
    { passId: above.id, below: below.id, merge: merged.sha, kind: merged.kind },
    'stacked pass took the base in',
  );
}

/** The pass stacked on `below` on a `local` project: any but an abandoned one, newest first. */
export function localStackedAbove(db: DbReader, below: PassDto): PassDto | undefined {
  for (const state of [PassState.Open, PassState.Closing, PassState.Closed, PassState.Settled])
    for (const above of listPassesIn(db, state).reverse())
      if (above.id !== below.id && getPassProgress(db, above.id).stackedOn === below.id)
        return above;
  return undefined;
}

/**
 * Spec §5.3 on a `local` project, after a read of a settled pass's record pull request: once it
 * merges, the record pull request of the pass stacked on it is based on the base; one closed
 * unmerged offers Retarget, as D24 does.
 */
export async function followLocalRecord(
  ctx: DeliveryContext,
  below: PassDto,
  signal: AbortSignal,
): Promise<void> {
  const above = localStackedAbove(ctx.state.db, below);
  if (above === undefined) return;
  const state = getPassPullRequest(ctx.state.db, below.id)?.state;
  if (state === PullRequestState.Merged) await retarget(ctx, above, signal);
  else if (state === PullRequestState.Closed) await offerRetarget(ctx, below, above, signal);
}

/** D24's card, call 35: the pass this one is stacked on closed unmerged; Retarget bases its pull request on the base. */
function retargetCard(above: PassDto, below: PassDto, base: string, prUrl: string | null): Card {
  const detail: PassRetargetDetail = {
    kind: 'pass_retarget',
    passId: above.id,
    stackedOn: below.id,
    base,
  };
  return {
    title: `Retarget "${above.name}" to ${base}`,
    body: [
      `Pass "${below.name}", which pass "${above.name}" is built on, closed without merging${prUrl === null ? '' : ` (${prUrl})`}.`,
      '',
      `Retarget bases the pull request of "${above.name}" on ${base}; it then carries the work of "${below.name}" as well as its own. Nothing is retargeted by itself.`,
    ].join('\n'),
    foldKey: passRetargetKey(above.id),
    detail,
    options: [
      {
        label: PASS_RETARGET_CHOICE,
        description: `Bases the pull request on ${base}, with both passes' work in it`,
      },
    ],
  };
}

/**
 * The branch the stacked pass's pull request targets on GitHub; null when it has none, or when gh
 * could not read it, so a failed read never keeps the card from being offered.
 */
async function prBaseOf(
  ctx: DeliveryContext,
  above: PassDto,
  signal: AbortSignal,
): Promise<string | null> {
  const batch = getBatch(ctx.state.db, above.batchId);
  const pr = getPassPullRequest(ctx.state.db, above.id);
  if (pr === null || batch.repo === null) return null;
  try {
    const seen = await ctx.gh.prView({ repo: batch.repo, ref: pr.url }, ghCall(ctx, signal));
    return seen?.baseRef ?? null;
  } catch (error) {
    ctx.logger.warn(
      { passId: above.id, err: error instanceof Error ? error.message : String(error) },
      "stacked pass's pull request base not read",
    );
    return null;
  }
}

/** Whether the builder answered the stacked pass's Retarget card with Retarget. */
function retargetChosen(db: DbReader, above: PassDto): boolean {
  return listInbox(db, {
    projectId: above.projectId,
    states: [InboxState.Answered, InboxState.Delivering, InboxState.Resolved],
  }).some((item) => item.answer !== null && retargetAnswered(item, item.answer) === above.id);
}

/**
 * The pass below a stacked one closed unmerged: the stacked pass's header says so and offers
 * Retarget. Where its pull request is based on GitHub decides, not the answer alone: one based on
 * the base already (retargeted, by 10db or by hand) clears the card and the notice; one a Retarget
 * answered did not move (a failed edit, a restart) is retargeted now; any other answer, or an open
 * card, is left as it is.
 */
export async function offerRetarget(
  ctx: DeliveryContext,
  below: PassDto,
  above: PassDto,
  signal: AbortSignal,
): Promise<void> {
  const db = ctx.state.db;
  const key = passRetargetKey(above.id);
  const base = getBatch(db, above.batchId).baseBranch;
  if ((await prBaseOf(ctx, above, signal)) === base) {
    withdraw(ctx.state, ctx.inbox, above.projectId, [key]);
    ctx.state.write((w) => clearPassNotice(w, above.id, STACK_NOTICE));
    return;
  }
  if (findOpenByFoldKey(db, above.projectId, key) !== undefined) return;
  if (retargetChosen(db, above)) {
    await retargetStackedPass(ctx, above.id, signal);
    return;
  }
  if (hasAnsweredByFoldKey(db, above.projectId, key)) return;
  raise(
    ctx.inbox,
    above.projectId,
    retargetCard(above, below, base, getBatch(db, below.batchId).prUrl),
  );
  const card = findOpenByFoldKey(db, above.projectId, passRetargetKey(above.id));
  ctx.state.write((w) => {
    setPassNotice(w, above.id, {
      id: STACK_NOTICE,
      kind: PassNoticeKind.StackUnmerged,
      text: `Pass "${below.name}", which this pass is built on, did not merge.`,
      sendable: false,
      cardId: card?.id ?? null,
      at: w.now,
    });
  });
}

/** The Retarget card's answer: the stacked pass's pull request is based on the base. */
export async function retargetStackedPass(
  ctx: DeliveryContext,
  passId: PassId,
  signal: AbortSignal,
): Promise<void> {
  const above = getPass(ctx.state.db, passId);
  await retarget(ctx, above, signal);
  ctx.state.write((w) => clearPassNotice(w, above.id, STACK_NOTICE));
}

/** The Retarget card's detail, read back from the database, when `item` is one answered with Retarget. */
export function retargetAnswered(item: InboxItemDto, answer: InboxAnswer): PassId | null {
  // The detail is JSON read back from the database: a boundary, so parse it.
  const detail = PassRetargetDetail.safeParse(item.detail);
  return detail.success && answer.choice === PASS_RETARGET_CHOICE ? detail.data.passId : null;
}
