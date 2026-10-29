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
  Later: 'Later',
} as const;
export type BatchCardChoice = (typeof BatchCardChoice)[keyof typeof BatchCardChoice];

const BatchCardDetail = z.object({ batchId: BatchId, workstreamId: WorkstreamId });

const OPTIONS: readonly InboxOption[] = [
  { label: BatchCardChoice.Retry, description: 'Run this workstream again in its batch' },
  {
    label: BatchCardChoice.ShipAnyway,
    description: 'Ship the batch without it, once the rest is done or cancelled',
  },
  {
    label: BatchCardChoice.Later,
    description: "Leave the batch open; decide later in the task's drawer",
  },
];

/** The failed-workstream card's options and detail when the workstream runs in a batch (spec §4). */
export function batchCardFields(row: {
  readonly id: WorkstreamId;
  readonly batchId: BatchId | null;
}): { options: InboxOption[]; detail: Record<string, Json> } | null {
  if (row.batchId === null) return null;
  return {
    options: [...OPTIONS],
    detail: { [BATCH_CARD_DETAIL]: { batchId: row.batchId, workstreamId: row.id } },
  };
}

/**
 * Acts on a batch card's answer before the inbox records it. A refusal (Ship anyway while work is
 * unfinished, in an open or a failed batch, or Retry in a batch that shipped) throws, so the card
 * stays open and the builder sees why. Ship anyway never reopens a failed batch: the option
 * promises a ship, and reopening is the strip's Retry.
 */
export function createBatchCardAnswers(deps: {
  readonly retry: (id: WorkstreamId) => void;
  readonly shipper: Pick<Shipper, 'shipAnyway'>;
}): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const card = BatchCardDetail.safeParse(item.detail?.[BATCH_CARD_DETAIL]);
    if (!card.success) return;
    if (answer.choice === BatchCardChoice.Retry) deps.retry(card.data.workstreamId);
    else if (answer.choice === BatchCardChoice.ShipAnyway)
      deps.shipper.shipAnyway(card.data.batchId);
    // Later, or a label the inbox's own option check refuses next: nothing to do.
  };
}
