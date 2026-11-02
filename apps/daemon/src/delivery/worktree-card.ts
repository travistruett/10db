import {
  BatchId,
  BatchState,
  type InboxAnswer,
  type InboxItemDto,
  type ProjectId,
} from '@10db/contracts';
import { getBatch, getBatchRow, getProject, patchBatch } from '@10db/db';
import { z } from 'zod';
import { returnCheckout } from './checkout-return';
import {
  CheckoutChoice,
  WORKTREE_CARD_DETAIL,
  WorktreeChoice,
  worktreeCards,
  type WorktreeOffer,
} from './cards';
import { raise, type DeliveryContext } from './context';
import { jobKey, JobQueue } from './jobs';
import type { BatchStarter } from './start';
import { retireWorktree } from './worktree-cleanup';
import { deleteStrayDirectory } from './worktree-leftover';
import { removeOrphanedWorktree } from './worktree-sweep';

const Place = z.object({ branch: z.string().nullable(), sha: z.string() });

/** What a worktree or checkout card carries (`worktreeOffer`), read back as the JSON it was stored as. */
const Offer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('batch'), batchId: BatchId }),
  z.object({ kind: z.literal('abandon'), batchId: BatchId }),
  z.object({ kind: z.literal('kept'), batchId: BatchId }),
  z.object({ kind: z.literal('orphan'), path: z.string() }),
  z.object({ kind: z.literal('stray'), path: z.string() }),
  z.object({
    kind: z.literal('checkout'),
    batchId: BatchId,
    place: Place,
    base: z.string().optional(),
  }),
]);

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Acts on the answer to a worktree or checkout card before the inbox records it:
 *
 * - Retry makes a failed batch's worktree whole again and reopens it (the starter's reopen); Abandon batch
 *   abandons it, as the Board's Abandon does. A batch that has moved on since is left alone, and the
 *   card closes.
 * - Remove worktree removes a kept worktree, whatever it holds, and Delete directory a directory git
 *   doesn't list as a worktree (only one under the worktree root). Both run in the project's queue; one
 *   that fails raises a new card saying why, with the same offer. An orphan that is no longer one (git
 *   doesn't list it, a batch holds it again, 10db no longer has it locked) is left, and a card says nothing was removed and why.
 * - Switch back, or Switch to the base branch, puts the shared checkout on the place the batch found it
 *   at (or on the batch's base branch) and raises the card for whatever is still in the way.
 *
 * Keep, Leave it, or any other label changes nothing.
 */
export function createWorktreeCardAnswers(
  ctx: DeliveryContext,
  deps: {
    readonly starter: Pick<BatchStarter, 'reopen'>;
    /** Abandons an open or failed batch (the shipper's abandon). */
    readonly abandon: (batchId: BatchId) => unknown;
  },
): (item: InboxItemDto, answer: InboxAnswer) => void {
  const queue = (projectId: ProjectId): string => `${projectId}:${JobQueue.Ship}`;

  const abandon = (batchId: BatchId): void => {
    const state = getBatch(ctx.state.db, batchId).state;
    if (state === BatchState.Open || state === BatchState.Failed) deps.abandon(batchId);
  };

  /** Runs `remove` in the project's queue; a failure raises a card that offers it again. */
  const removing = (
    projectId: ProjectId,
    offer: Extract<WorktreeOffer, { kind: 'kept' | 'orphan' | 'stray' }>,
    path: string,
    remove: () => Promise<void>,
  ): void => {
    ctx.jobs.run(queue(projectId), async () => {
      try {
        await remove();
      } catch (error) {
        ctx.logger.warn({ projectId, path, err: message(error) }, 'worktree not removed');
        raise(ctx.inbox, projectId, worktreeCards.removeFailed(offer, path, error));
      }
    });
  };

  return (item, answer) => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const parsed = Offer.safeParse(item.detail?.[WORKTREE_CARD_DETAIL]);
    if (!parsed.success) return;
    const offer = parsed.data;
    switch (offer.kind) {
      case 'batch':
        if (answer.choice === WorktreeChoice.Retry) deps.starter.reopen(offer.batchId);
        else if (answer.choice === WorktreeChoice.Abandon) abandon(offer.batchId);
        return;
      case 'abandon':
        if (answer.choice === WorktreeChoice.Abandon) abandon(offer.batchId);
        return;
      case 'kept': {
        if (answer.choice !== WorktreeChoice.Remove) return;
        const path = getBatch(ctx.state.db, offer.batchId).worktreePath;
        if (path === null) return;
        const batch = getBatch(ctx.state.db, offer.batchId);
        ctx.jobs.run(jobKey(batch, JobQueue.Ship), async () => {
          try {
            await retireWorktree(ctx, offer.batchId, true);
          } catch (error) {
            ctx.logger.warn(
              { batchId: offer.batchId, err: message(error) },
              'worktree not removed',
            );
            raise(ctx.inbox, batch.projectId, worktreeCards.removeFailed(offer, path, error));
          }
        });
        return;
      }
      case 'orphan': {
        if (answer.choice !== WorktreeChoice.Remove) return;
        const project = getProject(ctx.state.db, item.projectId);
        removing(project.id, offer, offer.path, async () => {
          const outcome = await removeOrphanedWorktree(
            {
              state: ctx.state,
              git: ctx.git,
              inbox: ctx.inbox,
              root: ctx.worktreeRoot,
              logger: ctx.logger,
            },
            project,
            offer.path,
          );
          if (!outcome.removed) {
            ctx.logger.info(
              { projectId: project.id, path: offer.path, why: outcome.why },
              'orphaned worktree not removed: no longer an orphan',
            );
            raise(ctx.inbox, project.id, worktreeCards.orphanNotRemoved(offer.path, outcome.why));
          }
        });
        return;
      }
      case 'stray':
        if (answer.choice !== WorktreeChoice.Delete) return;
        removing(item.projectId, offer, offer.path, () => {
          deleteStrayDirectory(ctx.worktreeRoot, offer.path);
          return Promise.resolve();
        });
        return;
      case 'checkout': {
        const toBase = answer.choice === CheckoutChoice.SwitchBase && offer.base !== undefined;
        if (answer.choice !== CheckoutChoice.SwitchBack && !toBase) return;
        const batch = getBatch(ctx.state.db, offer.batchId);
        // The switch back forgets its place once it has tried, so the card puts it back for one more try.
        const place = toBase ? { branch: offer.base ?? null, sha: offer.place.sha } : offer.place;
        ctx.jobs.run(jobKey(batch, JobQueue.Ship), async () => {
          if (getBatchRow(ctx.state.db, offer.batchId).returnSha === null)
            ctx.state.write((w) =>
              patchBatch(w, offer.batchId, { returnBranch: place.branch, returnSha: place.sha }),
            );
          await returnCheckout(ctx, offer.batchId);
        });
        return;
      }
    }
  };
}
