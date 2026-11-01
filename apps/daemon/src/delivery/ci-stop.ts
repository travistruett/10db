import {
  BatchId,
  BatchState,
  isTerminal,
  PullRequestState,
  type BatchDto,
  type CiStopped,
  type InboxAnswer,
  type InboxItemDto,
  type WorkstreamId,
} from '@10db/contracts';
import { getBatch, listBatches, listWorkstreams, patchBatch, type DbReader } from '@10db/db';
import type { WriteContext } from '@10db/db';
import { z } from 'zod';
import { CI_RERUN_CHOICE, CI_RERUN_DETAIL, prCardKey, prCards, detailOf } from './cards';
import { ghCall, raise, raiseIn, withdrawIn, type DeliveryContext } from './context';

/** The fix batches made for a root batch's pull request, in any state. */
export function fixesOf(db: DbReader, root: BatchDto): BatchDto[] {
  return listBatches(db, { projectId: root.projectId }).filter((b) => b.ciFixOf === root.id);
}

/** A pull request that merged or closed has nothing left to fix. */
const ended = (root: BatchDto): boolean =>
  root.pr?.state === PullRequestState.Merged || root.pr?.state === PullRequestState.Closed;

/**
 * Stops fixing the root batch's pull request, in the caller's write: sets `ciStopped` and raises the
 * card that names the failing checks and offers to rerun them, so a stop never exists without its
 * card. A root that is stopped already, or whose pull request merged or closed, changes nothing.
 * `note` is the cut's reason when a fix cut was refused.
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
  raiseIn(
    write,
    root.projectId,
    prCards.ciStopped(
      root,
      reason,
      root.prRequired?.failing ?? [],
      fixesOf(write.tx, root).length,
      note,
    ),
  );
}

/**
 * Lifts a stop the checks have moved past, in the caller's write: sets `ciStopped` null and closes
 * its card. Nothing happens for a root that is not stopped.
 */
export function clearCiStop(write: WriteContext, rootId: BatchId): void {
  const root = getBatch(write.tx, rootId);
  if (root.ciStopped === null) return;
  patchBatch(write, root.id, { ciStopped: null });
  withdrawIn(write, root.projectId, [prCardKey.ciStopped(root.id)]);
}

const RerunDetail = z.object({ batchId: BatchId });

/**
 * Acts on the stop card's Retry before the inbox records it: reruns the failed jobs of each failing
 * GitHub Actions run (`gh run rerun --failed`), once per run. The card closes with the answer; the
 * stop lifts when the next read finds the required checks running again. GitHub refusing a rerun
 * raises a card saying why. Any other answer changes nothing.
 */
export function createCiStopAnswers(
  ctx: DeliveryContext,
): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const card = RerunDetail.safeParse(item.detail?.[CI_RERUN_DETAIL]);
    if (!card.success || answer.choice !== CI_RERUN_CHOICE) return;
    const root = getBatch(ctx.state.db, card.data.batchId);
    const repo = root.repo;
    if (repo === null) return;
    const runs = [
      ...new Set(
        (root.prRequired?.failing ?? []).flatMap((check) =>
          check.runId === null ? [] : [check.runId],
        ),
      ),
    ];
    const call = ghCall(ctx, new AbortController().signal);
    void (async () => {
      const errors: unknown[] = [];
      for (const runId of runs) {
        try {
          await ctx.gh.rerunFailed({ repo, runId }, call);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 0) return;
      ctx.logger.warn(
        { batchId: root.id, err: detailOf(errors[0]) },
        'could not rerun failed CI jobs',
      );
      raise(ctx.inbox, root.projectId, prCards.rerunFailed(root, errors[0]));
    })();
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
