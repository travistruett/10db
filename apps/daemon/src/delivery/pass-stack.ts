import {
  PASS_RETARGET_CHOICE,
  PassNoticeKind,
  PassRetargetDetail,
  PassState,
  type InboxAnswer,
  type InboxItemDto,
  type PassDto,
  type PassId,
} from '@10db/contracts';
import {
  clearPassNotice,
  findOpenByFoldKey,
  getBatch,
  getPass,
  getPassProgress,
  getPassPullRequest,
  getProject,
  listPassesIn,
  passHoldingFolder,
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

/**
 * In the write that opens pass `passId` (D24): when the pass still holding the project's folder has
 * closed and not settled, the new pass stacks on it, and that pass's Move card waits while the new
 * one is open (`subscribePassSettles`). Answers that pass, or undefined.
 */
export function stackOn(w: WriteContext, passId: PassId): PassDto | undefined {
  const pass = getPass(w.tx, passId);
  const below = passHoldingFolder(w.tx, pass.projectId);
  if (below === undefined || below.id === passId || below.state !== PassState.Closed)
    return undefined;
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
    const lowerTip = await ctx.git.branchTip(project.repoPath, lower);
    const same =
      base !== null &&
      lowerTip !== null &&
      (await ctx.git.filesChangedBetween(project.repoPath, base, lowerTip)).length === 0;
    if (same) await takeBase(ctx, above, below, base, signal);
    else
      ctx.state.write((w) => {
        setPassNotice(w, above.id, {
          id: STACK_NOTICE,
          kind: PassNoticeKind.StackMerged,
          text: `Pass "${below.name}", which this pass is built on, merged into ${batch.baseBranch} with other changes, so this pull request lists its commits beside this pass's until it merges.`,
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
  // whose tree is the same, so its realignment still finds it at the tip.
  if (above.state === PassState.Closed && before !== null && merged.kind === 'merged')
    await ctx.git.moveBranchCas({
      repo: project.repoPath,
      branch: above.returnBranch,
      to: merged.sha,
      expect: before,
    });
  const pushed = await ctx.git.trackingTip(project.repoPath, branch);
  if (pushed !== null && pushed !== merged.sha)
    await pushBranch(ctx, batch, project, branch, signal);
  ctx.logger.info(
    { passId: above.id, below: below.id, merge: merged.sha, kind: merged.kind },
    'stacked pass took the base in',
  );
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

/** The pass below a stacked one closed unmerged: the stacked pass's header says so and offers Retarget. */
export function offerRetarget(ctx: DeliveryContext, below: PassDto, above: PassDto): void {
  const db = ctx.state.db;
  const base = getBatch(db, above.batchId).baseBranch;
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
