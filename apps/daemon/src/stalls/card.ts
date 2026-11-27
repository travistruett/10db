import {
  BatchId,
  BuilderOwns,
  InboxKind,
  isTerminal,
  Urgency,
  WorkstreamId,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
} from '@10db/contracts';
import { getWorkstreamRow } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { CardTier, decidedByBuilder, type FlagInput } from '../inbox';
import type { Logger } from '../log';
import { StallAction, type Stall } from './rules';

/** The `detail` key of a Stuck card: what it was raised for, which its answers act on. */
export const STALL_CARD = 'stallCard';

export const StallCardDetail = z.object({
  key: z.string().min(1),
  fingerprint: z.string(),
  since: z.iso.datetime(),
  workstreamId: WorkstreamId.nullable(),
  batchId: BatchId.nullable(),
  dependencyRunId: WorkstreamId.nullable(),
  waitingRunIds: z.array(WorkstreamId),
});
export type StallCardDetail = z.infer<typeof StallCardDetail>;

const SINCE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const ACTION_WORDS: Readonly<Record<StallAction, string>> = {
  [StallAction.CancelRun]: 'Stops this run, as Cancel on the Board does.',
  [StallAction.RetryDependency]: 'Runs the failed task it waits for again.',
  [StallAction.CancelWaiting]:
    "Cancels the tasks that can't start, so the batch can ship without them.",
  [StallAction.AbandonBatch]: "Abandons the batch: its work doesn't land.",
};

/** The card's detail, read back from the database: a boundary, so it is parsed. */
export function stallCardOf(item: InboxItemDto): StallCardDetail | null {
  const parsed = StallCardDetail.safeParse(item.detail?.[STALL_CARD]);
  return parsed.success ? parsed.data : null;
}

/** The one Stuck card of a stall: what is stuck, why, since when, and the ways out 10db has. */
export function stallCard(stall: Stall): FlagInput {
  const detail: StallCardDetail = {
    key: stall.key,
    fingerprint: stall.fingerprint,
    since: stall.since,
    workstreamId: stall.workstreamId,
    batchId: stall.batchId,
    dependencyRunId: stall.dependencyRunId,
    waitingRunIds: [...stall.waitingRunIds],
  };
  const options: InboxOption[] = stall.actions.map((label) => ({
    label,
    description: ACTION_WORDS[label],
  }));
  return {
    projectId: stall.projectId,
    tier: CardTier.Ask,
    urgency: Urgency.High,
    closesWhen: { by: 'event', when: { event: 'stall_cleared', key: stall.key } },
    decision: decidedByBuilder(BuilderOwns.OutOfMoves),
    workstreamId: stall.workstreamId,
    title: `Stuck: ${stall.title}`,
    body: [
      stall.reason,
      // A fixed time, in this Mac's own: the card is written once and stays true while it is open.
      `It has not moved since ${SINCE.format(new Date(stall.since))}.`,
      '10db changes nothing by itself; this card closes once it moves.',
    ].join('\n\n'),
    detail: { [STALL_CARD]: detail },
    foldKey: stall.key,
    refresh: true,
    options,
  };
}

/**
 * Acts on the builder's answer to a Stuck card. Cancel Run and Cancel Waiting Tasks cancel as the
 * Board does (a failure is logged); Retry Dependency retries the failed run the card names; Abandon
 * Batch abandons its batch, and a refusal throws so the card stays open. Any other card is left alone.
 */
export function createStallCardAnswers(deps: {
  readonly state: StateStore;
  cancel(id: WorkstreamId): Promise<void>;
  retry(id: WorkstreamId): void;
  abandon(id: BatchId): void;
  readonly log: Logger;
}): (item: InboxItemDto, answer: InboxAnswer) => void {
  const cancel = (id: WorkstreamId): void => {
    if (isTerminal(getWorkstreamRow(deps.state.db, id).state)) return;
    deps.cancel(id).catch((error: unknown) => {
      deps.log.error({ err: error, workstreamId: id }, 'could not cancel a stuck run');
    });
  };
  return (item, answer) => {
    if (item.kind !== InboxKind.Flag) return;
    const card = stallCardOf(item);
    if (card === null) return;
    switch (answer.choice) {
      case StallAction.CancelRun:
        if (card.workstreamId !== null) cancel(card.workstreamId);
        return;
      case StallAction.CancelWaiting:
        for (const id of card.waitingRunIds) cancel(id);
        return;
      case StallAction.RetryDependency:
        if (card.dependencyRunId !== null) deps.retry(card.dependencyRunId);
        return;
      case StallAction.AbandonBatch:
        if (card.batchId !== null) deps.abandon(card.batchId);
        return;
      default:
        return;
    }
  };
}
