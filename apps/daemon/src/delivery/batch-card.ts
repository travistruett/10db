import {
  BatchId,
  WorkstreamId,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
} from '@10db/contracts';
import type { Json } from '@10db/db';
import { z } from 'zod';
import type { Shipper } from './ship';

/** The `detail` key of a failed batch member's card. */
export const BATCH_CARD_DETAIL = 'batchCard';

export const BatchCardChoice = {
  Retry: 'Retry',
  ShipAnyway: 'Ship anyway',
  ShipWithout: 'Ship without it',
  Later: 'Later',
} as const;
export type BatchCardChoice = (typeof BatchCardChoice)[keyof typeof BatchCardChoice];

/** `revert` is the revert commit an earlier Ship without it left on the branch, if it did. */
const BatchCardDetail = z.object({
  batchId: BatchId,
  workstreamId: WorkstreamId,
  revert: z.string().optional(),
});

const OPTIONS: readonly InboxOption[] = [
  {
    label: BatchCardChoice.Retry,
    // The card is not rewritten when the task's placement changes, and `BatchStarter.retry` refuses
    // a task that moved, so the offer says so itself.
    description:
      "Run this workstream again in its batch. Refused if the task has since been set to work somewhere else: set it back, or start it over from the task's drawer",
  },
  {
    label: BatchCardChoice.ShipAnyway,
    description:
      'Ship the batch once the rest is done or cancelled. This task failed, but its commits will be in the pull request',
  },
  {
    label: BatchCardChoice.ShipWithout,
    description:
      'Reverts its commits on the batch branch in one revert commit, then ships the finished tasks. Every other task that failed in this batch is left out too, so no rejected commits ship. If the revert conflicts, nothing ships and a card names the files. Needs another finished task',
  },
  {
    label: BatchCardChoice.Later,
    description: "Leave the batch open; decide later in the task's drawer",
  },
];

/**
 * The options of a card whose Ship without it left its revert on the branch. No Retry: the run has no
 * left-out notice yet, so a retried session would not be told its commits are gone.
 */
const REVERTED_OPTIONS: readonly InboxOption[] = [
  {
    label: BatchCardChoice.ShipAnyway,
    description:
      "Ship the branch as it stands once the rest is done or cancelled. The revert is in it, so this task's commits stay out of the pull request, but neither that nor the task's drawer says why",
  },
  {
    label: BatchCardChoice.ShipWithout,
    description:
      'Keeps the revert on the branch, reverts only commits it does not cover, says in the drawer and the pull request that the work was left out, then ships the finished tasks',
  },
  {
    label: BatchCardChoice.Later,
    description:
      "Close this card and leave the batch open, with the revert on the branch. The task's drawer offers Ship anyway, not Ship without it",
  },
];

/**
 * The failed-workstream card's options and detail when the workstream runs in a batch (spec §4).
 * `revert` is the revert commit an earlier Ship without it left on the branch: the answer needs it,
 * because reverting those commits again can conflict.
 */
export function batchCardFields(
  row: { readonly id: WorkstreamId; readonly batchId: BatchId | null },
  revert?: string | null,
): { options: InboxOption[]; detail: Record<string, Json> } | null {
  if (row.batchId === null) return null;
  const card = { batchId: row.batchId, workstreamId: row.id };
  return {
    options: [...(revert ? REVERTED_OPTIONS : OPTIONS)],
    detail: { [BATCH_CARD_DETAIL]: revert ? { ...card, revert } : card },
  };
}

/**
 * Acts on a batch card's answer before the inbox records it. A refusal (Ship anyway while work is
 * unfinished, in an open or a failed batch, or Retry in a batch that shipped) throws, so the card
 * stays open and the builder sees why. Ship anyway never reopens a failed batch: the option
 * promises a ship, and reopening is the strip's Retry. Ship anyway puts the failed task's commits
 * in the pull request; Ship without it reverts them, and those of every other failed task of the
 * batch, first, and refuses on the same grounds (`Shipper.shipWithout`). A card whose revert stopped
 * (`leftOutCards`) carries this card's detail and choices, so the builder answers it the same way.
 */
export function createBatchCardAnswers(deps: {
  /** Retries the workstream; `note` is the builder's, for the session the retry sends the work to. */
  readonly retry: (id: WorkstreamId, note?: string) => void;
  readonly shipper: Pick<Shipper, 'shipAnyway' | 'shipWithout'>;
}): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const card = BatchCardDetail.safeParse(item.detail?.[BATCH_CARD_DETAIL]);
    if (!card.success) return;
    if (answer.choice === BatchCardChoice.Retry) {
      const note = answer.note?.trim();
      if (note) deps.retry(card.data.workstreamId, note);
      else deps.retry(card.data.workstreamId);
    } else if (answer.choice === BatchCardChoice.ShipAnyway)
      deps.shipper.shipAnyway(card.data.batchId);
    else if (answer.choice === BatchCardChoice.ShipWithout)
      deps.shipper.shipWithout(card.data.batchId, card.data.workstreamId, card.data.revert);
    // Later, or a label the inbox's own option check refuses next: nothing to do.
  };
}
