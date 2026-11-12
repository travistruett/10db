import {
  BatchId,
  EventType,
  PassClosePageChoice,
  PassNoticeKind,
  PassState,
  PullRequestState,
  TaskStatus,
  type PassCloseRequest,
  type PassDto,
  type PassFollowOnDetail,
  type PassId,
  type TaskId,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getBatch,
  getPass,
  getPassProgress,
  getPassPullRequest,
  getProject,
  getTask,
  hasAnsweredByFoldKey,
  passHoldingTask,
  setPassNotice,
  type DbReader,
} from '@10db/db';
import type { EventBus } from '../events';
import { flagCard } from '../inbox';
import type { CloseDeps } from './close';
import { passBranch } from './kept-work';
import { unfinishedPages } from './unowned';

// Workbench spec §5.4, call 6: a pull request that merges while its pass is open closes the pass by
// itself. The close is Close Pass's, from a plan 10db writes: every unfinished page is taken out
// and nothing is signed off, placed or dropped; it runs no gate and pushes nothing, since the merged
// work is in the base already. The pages signed off after the last push ride the follow-on pass
// that the unfinished pages carry over to, stacked on this one; with none unfinished, they are
// pushed and a follow-on pull request is opened against the base.

/**
 * The token of a close plan 10db wrote for a merged pull request. A builder's plan carries the
 * preview's token, which never takes this value, so the plan itself says how the close runs, also
 * across a restart.
 */
const MERGED_CLOSE_TOKEN = 'merged-while-open';

/** Whether `plan` is the close of a pass whose pull request merged while it was open. */
export function isMergedClose(plan: PassCloseRequest): boolean {
  return plan.token === MERGED_CLOSE_TOKEN;
}

/** Whether the open pass's pull request has merged, so the pass must close (call 6). */
export function mergedWhileOpen(db: DbReader, passId: PassId): boolean {
  return (
    getPass(db, passId).state === PassState.Open &&
    getPassPullRequest(db, passId)?.state === PullRequestState.Merged
  );
}

/** The close plan of a merged pass: each unfinished page taken out, its shared changes kept. */
export function mergedClosePlan(db: DbReader, passId: PassId): PassCloseRequest {
  return {
    token: MERGED_CLOSE_TOKEN,
    pages: unfinishedPages(db, passId).map((task) => ({
      taskId: task.id,
      choice: PassClosePageChoice.TakeOut,
    })),
    files: [],
    shared: [],
  };
}

/** The pages a merged close takes out, which carry over to the follow-on pass. */
const carriedOf = (plan: PassCloseRequest): TaskId[] =>
  plan.pages.filter((p) => p.choice === PassClosePageChoice.TakeOut).map((p) => p.taskId);

/** The header notice of a merged close whose follow-on pull request did not open. */
const FOLLOW_ON_NOTICE = 'follow-on';

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Step 6 of a merged close. With unfinished pages nothing is pushed: what was signed off after the
 * last push rides their follow-on pass. With none, the pages signed off after the last push are
 * pushed with a follow-on pull request against the base; a tip that is the pushed one needs none.
 * One that does not open is a header notice, and the close goes on.
 */
export async function followOnPush(
  deps: CloseDeps,
  passId: PassId,
  plan: PassCloseRequest,
  signal: AbortSignal,
): Promise<void> {
  if (carriedOf(plan).length > 0) return;
  const db = deps.state.db;
  const pass = getPass(db, passId);
  const repo = getProject(db, pass.projectId).repoPath;
  const branch = passBranch(db, pass);
  const tip = await deps.git.commitAt(repo, branch);
  const stillMerged = getPassPullRequest(db, passId)?.state === PullRequestState.Merged;
  if (stillMerged && (await deps.git.trackingTip(repo, branch)) === tip) return;
  try {
    await deps.ship.openFollowOnPr(passId, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    deps.state.write((ctx) => {
      setPassNotice(ctx, passId, {
        id: FOLLOW_ON_NOTICE,
        kind: PassNoticeKind.PrNotOpened,
        text: `The pull request merged while the pass was open, and the pages signed off after its last push did not reach a follow-on pull request: ${errorText(error)}. Open one on GitHub from ${branch}.`,
        sendable: false,
        cardId: null,
        at: ctx.now,
      });
    });
  }
}

/** The fold key of a merged pass's one follow-on card, which also marks its carry-over done. */
const followOnKey = (passId: PassId): string => `pass-follow-on:${passId}`;

/** Whether the closed pass came from a merge and has not yet carried its pages over. */
export function carryOverDue(db: DbReader, passId: PassId): boolean {
  const pass = getPass(db, passId);
  if (pass.state !== PassState.Closed && pass.state !== PassState.Settled) return false;
  const plan = getPassProgress(db, passId).closePlan;
  if (plan === null || !isMergedClose(plan)) return false;
  const key = followOnKey(passId);
  return (
    findOpenByFoldKey(db, pass.projectId, key) === undefined &&
    !hasAnsweredByFoldKey(db, pass.projectId, key)
  );
}

/** The commits on the pass's branch since its last push, oldest first; none with no push. */
async function unpushedCommits(deps: CloseDeps, pass: PassDto): Promise<string[]> {
  const repo = getProject(deps.state.db, pass.projectId).repoPath;
  const branch = passBranch(deps.state.db, pass);
  const pushed = await deps.git.trackingTip(repo, branch);
  return pushed === null ? [] : deps.git.commitsSince(repo, pushed, branch);
}

/**
 * After a merged close, outside the delivery key: the pages it took out carry over to a follow-on
 * pass, opened as Start Pass opens one, which stacks on the closed pass and puts their kept work
 * back. One card says what happened. A page already in a pass (a restart after the opening) names
 * that pass; one no longer open stays where it is.
 */
export async function carryOver(deps: CloseDeps, passId: PassId): Promise<void> {
  const db = deps.state.db;
  if (!carryOverDue(db, passId)) return;
  const pass = getPass(db, passId);
  const plan = getPassProgress(db, passId).closePlan;
  if (plan === null) return;
  const carried = carriedOf(plan)
    .map((id) => getTask(db, id))
    .filter((task) => task.status === TaskStatus.Open);
  let followOnPassId: PassId | null =
    carried.map((task) => passHoldingTask(db, task)).find((p) => p !== undefined)?.id ?? null;
  let why: string | null = null;
  const free = carried.filter((task) => passHoldingTask(db, task) === undefined);
  if (followOnPassId === null && free.length > 0) {
    if (deps.openFollowOn === undefined) why = 'no pass can be opened here';
    else
      try {
        followOnPassId = (
          await deps.openFollowOn({
            projectId: pass.projectId,
            name: `${pass.name} (continued)`,
            taskIds: free.map((task) => task.id),
            pageCap: pass.pageCap,
          })
        ).pass.id;
      } catch (error) {
        why = errorText(error);
      }
  }
  const pr = getPassPullRequest(db, passId);
  const prUrl =
    carried.length === 0 && pr !== null && pr.state !== PullRequestState.Merged ? pr.url : null;
  const detail: PassFollowOnDetail = {
    kind: 'pass_follow_on',
    passId,
    followOnPassId,
    prUrl,
    carried: carried.map((task) => task.id),
  };
  // With no follow-on pass to ride, the pages signed off after the last push are on the branch
  // alone: the card names them, since nothing pushes them.
  const unpushed =
    carried.length > 0 && followOnPassId === null ? await unpushedCommits(deps, pass) : [];
  const titles = carried.map((task) => `"${task.title}"`).join(', ');
  const carriedLine =
    carried.length === 0
      ? []
      : followOnPassId === null
        ? [`${titles} went back to the Board with their work kept: ${why ?? 'no pass opened'}.`]
        : [
            `${titles} carried over to pass "${getPass(db, followOnPassId).name}", with the pages signed off after the last push.`,
          ];
  const body = [
    `The pull request of UI Workbench pass "${pass.name}" merged while the pass was open, so 10db closed it.`,
    ...carriedLine,
    ...(prUrl === null ? [] : [`The pages signed off after the last push are in ${prUrl}.`]),
    ...(unpushed.length === 0
      ? []
      : [
          `The pages signed off after the last push are on ${passBranch(db, pass)}, not pushed: ${unpushed.map((sha) => sha.slice(0, 7)).join(', ')}. Push it and open a pull request from it on GitHub.`,
        ]),
  ].join(' ');
  deps.state.write((ctx) =>
    flagCard(ctx, {
      projectId: pass.projectId,
      workstreamId: null,
      title: `UI Workbench pass "${pass.name}" closed when its pull request merged`,
      body,
      foldKey: followOnKey(passId),
      refresh: true,
      detail,
    }),
  );
  deps.logger.info(
    { passId, followOnPassId, prUrl, carried: detail.carried },
    'merged pass carried over',
  );
}

/**
 * Follows the pull request watch's writes: an open pass whose pull request is read as merged
 * closes by itself.
 */
export function subscribeMergedPasses(
  bus: EventBus,
  db: DbReader,
  closes: { closeMerged(passId: PassId): void },
): () => void {
  return bus.subscribe((event) => {
    if (event.type !== EventType.BatchUpdated) return;
    const id = BatchId.safeParse(event.entityId);
    if (!id.success) return;
    const passId = getBatch(db, id.data).passId;
    if (passId != null && mergedWhileOpen(db, passId)) closes.closeMerged(passId);
  });
}
