import {
  BatchId,
  BatchState,
  CiStopped,
  InboxAnswerRefused,
  isTerminal,
  PullRequestState,
  type BatchDto,
  type InboxAnswer,
  type InboxItemDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  clearBatchNotice,
  deleteAppSetting,
  getAppSetting,
  getBatch,
  listBatches,
  listWorkstreams,
  patchBatch,
  setAppSetting,
  setBatchNotice,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';
import { OUT_OF_MOVES_DETAIL, OutOfMovesChoice, OutOfMovesDetail, OutOfMovesKind } from '../inbox';
import { CI_RERUN_CHOICE, CI_RERUN_DETAIL, prCardKey, prCards, detailOf } from './cards';
import { ghCall, raise, raiseIn, withdrawIn, type DeliveryContext } from './context';
import { ciNotices, NOTICE_KEY } from './notices';

/** The fix batches made for a root batch's pull request, in any state. */
export function fixesOf(db: DbReader, root: BatchDto): BatchDto[] {
  return listBatches(db, { projectId: root.projectId }).filter((b) => b.ciFixOf === root.id);
}

/** A pull request that merged or closed has nothing left to fix. */
const ended = (root: BatchDto): boolean =>
  root.pr?.state === PullRequestState.Merged || root.pr?.state === PullRequestState.Closed;

// A pull request out of CI fixes: when it stopped, the builder's answers to its out-of-moves card, and
// the note the next fix carries. Deleted in the write that records the pull request merged or closed.

export const ciOutOfMovesKey = (rootId: BatchId): string => `ci_out_of_moves.${rootId}`;

/** How long a stop at the limit, or after a fix that changed nothing, waits before its card. */
export const CI_OUT_OF_MOVES_AFTER_MS = 30 * 60_000;

const CiOutOfMoves = z.object({
  /** When fixing stopped at the limit or on an unchanged head; null once the stop lifted. */
  stoppedAt: z.string().nullable(),
  /** When the builder spent more attempts: fixes made before it no longer count. */
  ignoreFixesBefore: z.string().nullable(),
  /** Change the Task's note, put at the top of the next fix task. */
  note: z.string().nullable(),
  /** Drop It closed the pull request, so its close raises no card of its own. */
  dropped: z.boolean(),
});
type CiOutOfMoves = z.infer<typeof CiOutOfMoves>;

const NONE: CiOutOfMoves = { stoppedAt: null, ignoreFixesBefore: null, note: null, dropped: false };

/** The root's setting; unset or unreadable reads as nothing stored. */
export function readCiOutOfMoves(db: DbReader, rootId: BatchId): CiOutOfMoves {
  // Read from the database: parsed, as at every boundary.
  const stored = CiOutOfMoves.safeParse(getAppSetting(db, ciOutOfMovesKey(rootId)));
  return stored.success ? stored.data : NONE;
}

export function patchCiOutOfMoves(
  w: WriteContext,
  rootId: BatchId,
  patch: Partial<CiOutOfMoves>,
): void {
  setAppSetting(w, ciOutOfMovesKey(rootId), { ...readCiOutOfMoves(w.tx, rootId), ...patch });
}

export function deleteCiOutOfMoves(w: WriteContext, rootId: BatchId): void {
  deleteAppSetting(w, ciOutOfMovesKey(rootId));
}

/** A stop that waits before its card: the checks may pass or run again by themselves first. */
const waits = (reason: CiStopped | null): boolean =>
  reason === CiStopped.Limit || reason === CiStopped.NoChange;

/**
 * Stops fixing the root batch's pull request, in the caller's write: sets `ciStopped`, and replaces
 * the pull request's "checks failed" card, so a stop never exists without its card or its pending
 * notice. A stop at the limit or on an unchanged head shows a notice on the root's tasks and its stop
 * time is stored; the watch raises the out-of-moves card `CI_OUT_OF_MOVES_AFTER_MS` later. Any other
 * stop raises its card at once, naming the failing checks and offering to rerun them. A root that is
 * stopped already, or whose pull request merged or closed, changes nothing. `note` is the cut's
 * reason when a fix cut was refused.
 */
export function stopCiFixing(
  write: WriteContext,
  rootId: BatchId,
  reason: CiStopped,
  note: string | null = null,
): void {
  const root = getBatch(write.tx, rootId);
  if (root.ciStopped !== null || ended(root)) return;
  patchBatch(write, root.id, { ciStopped: reason });
  withdrawIn(write, root.projectId, [prCardKey.checks(root.id)]);
  const fixes = fixesOf(write.tx, root).length;
  if (waits(reason)) {
    patchCiOutOfMoves(write, root.id, { stoppedAt: write.now });
    setBatchNotice(
      write,
      root.id,
      ciNotices.outOfMovesPending(root, fixes, CI_OUT_OF_MOVES_AFTER_MS / 60_000),
    );
    return;
  }
  raiseIn(
    write,
    root.projectId,
    prCards.ciStopped(root, reason, root.prRequired?.failing ?? [], fixes, note),
  );
}

/**
 * Lifts a stop the checks have moved past, in the caller's write: sets `ciStopped` null, closes its
 * card and clears its pending notice, so a stop lifted inside the window raises nothing. Nothing
 * happens for a root that is not stopped.
 */
export function clearCiStop(write: WriteContext, rootId: BatchId): void {
  const root = getBatch(write.tx, rootId);
  if (root.ciStopped === null) return;
  patchBatch(write, root.id, { ciStopped: null });
  withdrawIn(write, root.projectId, [prCardKey.ciStopped(root.id)]);
  clearBatchNotice(write, root.id, NOTICE_KEY.ciOutOfMoves);
  // Patched only when stored: the write that records a merge or close deletes it after this.
  if (getAppSetting(write.tx, ciOutOfMovesKey(root.id)) !== undefined)
    patchCiOutOfMoves(write, root.id, { stoppedAt: null });
}

/**
 * Raises the out-of-moves card of a root stopped at the limit or on an unchanged head, in the caller's
 * write, once `CI_OUT_OF_MOVES_AFTER_MS` passed since the stop (at once when no stop time is stored),
 * while its pull request is open and its notice still stands. The same write clears the notice, so the
 * card comes once, also after a restart.
 */
export function raiseCiOutOfMovesWhenDue(w: WriteContext, rootId: BatchId): void {
  const root = getBatch(w.tx, rootId);
  const reason = root.ciStopped;
  if (reason === null || !waits(reason) || root.pr?.state !== PullRequestState.Open) return;
  if (!root.notices.some((n) => n.key === NOTICE_KEY.ciOutOfMoves)) return;
  const { stoppedAt } = readCiOutOfMoves(w.tx, root.id);
  if (stoppedAt !== null && Date.parse(w.now) - Date.parse(stoppedAt) < CI_OUT_OF_MOVES_AFTER_MS)
    return;
  raiseIn(
    w,
    root.projectId,
    prCards.ciOutOfMoves(root, reason, root.prRequired?.failing ?? [], fixesOf(w.tx, root).length),
  );
  clearBatchNotice(w, root.id, NOTICE_KEY.ciOutOfMoves);
}

/**
 * Lifts the stop after the builder's answer, keeping no card: the stop card closed with the answer,
 * and its stop time and notice go with it. The next read decides again from the rows. A limit, an
 * unchanged head or a missing log stops again; a refused cut is tried once more, as the builder asked
 * for another go.
 */
function liftCiStop(ctx: DeliveryContext, rootId: BatchId): void {
  ctx.state.write((w) => {
    clearCiStop(w, rootId);
  });
}

/**
 * Reruns the failed jobs of each failing GitHub Actions run (`gh run rerun --failed`), once per run,
 * then lifts the stop, so a later read that still finds the checks failing decides again. GitHub
 * refusing a rerun also raises a card saying why.
 */
function rerunThenLift(ctx: DeliveryContext, root: BatchDto): void {
  const repo = root.repo;
  const runs =
    repo === null
      ? []
      : [
          ...new Set(
            (root.prRequired?.failing ?? []).flatMap((check) =>
              check.runId === null ? [] : [check.runId],
            ),
          ),
        ];
  const call = ghCall(ctx, new AbortController().signal);
  void (async () => {
    const errors: unknown[] = [];
    if (repo !== null)
      for (const runId of runs) {
        try {
          await ctx.gh.rerunFailed({ repo, runId }, call);
        } catch (error) {
          errors.push(error);
        }
      }
    // The card closed with the answer, and a stop that holds raises nothing more: lift it so the
    // next read decides again, and a rerun that fails (or never ran) brings back a card.
    liftCiStop(ctx, root.id);
    if (errors.length === 0) return;
    ctx.logger.warn(
      { batchId: root.id, err: detailOf(errors[0]) },
      'could not rerun failed CI jobs',
    );
    raise(ctx.inbox, root.projectId, prCards.rerunFailed(root, errors[0]));
  })();
}

/**
 * Drop It: closes the pull request. `dropped` is stored first, so the watch's read of the close raises
 * no "pull request closed" card, and the fix batches end as for any closed pull request. When GitHub
 * refuses, the out-of-moves card comes back beside a card saying why, and `dropped` is unset.
 */
function dropPullRequest(ctx: DeliveryContext, root: BatchDto): void {
  const { repo, prUrl } = root;
  if (repo === null || prUrl === null)
    throw new InboxAnswerRefused('10db does not know this pull request, so it cannot close it');
  ctx.state.write((w) => {
    patchCiOutOfMoves(w, root.id, { dropped: true });
  });
  const call = ghCall(ctx, new AbortController().signal);
  ctx.gh.closePullRequest({ repo, url: prUrl }, call).catch((error: unknown) => {
    ctx.logger.warn({ batchId: root.id, err: detailOf(error) }, 'could not close a pull request');
    ctx.state.write((w) => {
      const now = getBatch(w.tx, root.id);
      if (now.pr?.state !== PullRequestState.Open) return;
      patchCiOutOfMoves(w, now.id, { dropped: false });
      const reason = now.ciStopped;
      if (reason !== null && waits(reason))
        raiseIn(
          w,
          now.projectId,
          prCards.ciOutOfMoves(
            now,
            reason,
            now.prRequired?.failing ?? [],
            fixesOf(w.tx, now).length,
          ),
        );
      raiseIn(w, now.projectId, prCards.closeFailed(now, error));
    });
  });
}

const RerunDetail = z.object({ batchId: BatchId });

/**
 * Acts on a stop card's answer before the inbox records it. The stop card's Retry reruns the failed
 * jobs, then lifts the stop. On the out-of-moves card, Spend More Attempts counts no fix made before
 * it and does what Retry does; Change the Task does the same and the next fix task opens with the
 * note (refused without one); Drop It closes the pull request. Any other answer changes nothing.
 */
export function createCiStopAnswers(
  ctx: DeliveryContext,
): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const rerun = RerunDetail.safeParse(item.detail?.[CI_RERUN_DETAIL]);
    if (rerun.success) {
      if (answer.choice !== CI_RERUN_CHOICE) return;
      const root = getBatch(ctx.state.db, rerun.data.batchId);
      if (root.repo === null) return;
      rerunThenLift(ctx, root);
      return;
    }
    const parsed = OutOfMovesDetail.safeParse(item.detail?.[OUT_OF_MOVES_DETAIL]);
    if (!parsed.success || parsed.data.kind !== OutOfMovesKind.Ci) return;
    const batchId = parsed.data.batchId;
    if (batchId === null) return;
    const note = answer.note?.trim() ?? '';
    switch (answer.choice) {
      case OutOfMovesChoice.More:
      case OutOfMovesChoice.Change: {
        if (answer.choice === OutOfMovesChoice.Change && note === '')
          throw new InboxAnswerRefused('Change the Task needs a note saying what to change');
        const change = answer.choice === OutOfMovesChoice.Change;
        ctx.state.write((w) => {
          patchCiOutOfMoves(w, batchId, {
            ignoreFixesBefore: w.now,
            ...(change ? { note } : {}),
          });
        });
        rerunThenLift(ctx, getBatch(ctx.state.db, batchId));
        return;
      }
      case OutOfMovesChoice.Drop:
        dropPullRequest(ctx, getBatch(ctx.state.db, batchId));
        return;
      default:
        return;
    }
  };
}

/** What ending a fix needs of the runner and the shipper. */
export interface FixEnds {
  /** Ends the workstream's session (if any) and marks it cancelled, as a cancel from the Board does. */
  cancel(id: WorkstreamId): Promise<void>;
  /** Abandons an open or failed batch whose workstreams have all ended. */
  abandon(id: BatchId): unknown;
}

/**
 * Ends every fix batch that is OPEN or FAILED whose pull request has merged or closed: cancels each
 * live member, then abandons the batch. A batch that is being cut or shipped is left to its own
 * step (the ship reads the pull request first). One batch failing is logged and tried again next
 * round; it never stops the others.
 */
export async function endFixesOfEndedPullRequests(
  ctx: DeliveryContext,
  ends: FixEnds,
  signal: AbortSignal,
): Promise<void> {
  const db = ctx.state.db;
  const live = listBatches(db, { states: [BatchState.Open, BatchState.Failed] }).filter(
    (b) => b.ciFixOf !== null,
  );
  for (const fix of live) {
    if (signal.aborted) return;
    if (fix.ciFixOf === null) continue;
    try {
      if (!ended(getBatch(db, fix.ciFixOf))) continue;
      for (const ws of listWorkstreams(db, { batchId: fix.id })) {
        if (!isTerminal(ws.state)) await ends.cancel(ws.id);
      }
      const now = getBatch(db, fix.id);
      if (now.state !== BatchState.Open && now.state !== BatchState.Failed) continue;
      await ends.abandon(fix.id);
      ctx.logger.info(
        { batchId: fix.id, root: fix.ciFixOf },
        'ended a CI fix: its pull request merged or closed',
      );
    } catch (error) {
      ctx.logger.warn({ batchId: fix.id, err: detailOf(error) }, 'could not end a CI fix');
    }
  }
}
