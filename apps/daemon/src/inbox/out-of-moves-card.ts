import {
  BatchId,
  InboxAnswerRefused,
  isTerminal,
  WorkstreamId,
  WorkstreamState,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
} from '@10db/contracts';
import { getWorkstreamRow, listWorkstreams, type DbReader, type Json } from '@10db/db';
import { z } from 'zod';
import type { Logger } from '../log';

/** The `detail` key of an out-of-moves card: what stopped, which its answers act on. */
export const OUT_OF_MOVES_DETAIL = 'outOfMoves';

export const OutOfMovesChoice = {
  More: 'Spend More Attempts',
  Change: 'Change the Task',
  Drop: 'Drop It',
} as const;
export type OutOfMovesChoice = (typeof OutOfMovesChoice)[keyof typeof OutOfMovesChoice];

/**
 * What ran out of moves: a batch's ship gate, a run's retries, a run's recovery, a pull request's CI fixes,
 * or a run that stalled again after its one restart.
 */
export const OutOfMovesKind = {
  Gate: 'gate',
  Run: 'run',
  Recovery: 'recovery',
  Ci: 'ci',
  Stall: 'stall',
} as const;
export type OutOfMovesKind = (typeof OutOfMovesKind)[keyof typeof OutOfMovesKind];

/** `outside` is set on a gate card raised because the gate failed twice outside the batch. */
export const OutOfMovesDetail = z.object({
  kind: z.enum(OutOfMovesKind),
  more: z.number().int().positive(),
  batchId: BatchId.nullable(),
  workstreamId: WorkstreamId.nullable(),
  outside: z.boolean().optional(),
});
export type OutOfMovesDetail = z.infer<typeof OutOfMovesDetail>;

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function options(input: {
  readonly kind: OutOfMovesKind;
  readonly more: number;
  readonly batchId: BatchId | null;
}): InboxOption[] {
  switch (input.kind) {
    case OutOfMovesKind.Gate:
      return [
        {
          label: OutOfMovesChoice.More,
          description: `Files up to ${count(input.more, 'more fix task', 'more fix tasks')}`,
        },
        { label: OutOfMovesChoice.Change, description: 'Files one fix task with your note' },
        { label: OutOfMovesChoice.Drop, description: 'Abandons the batch; nothing is merged' },
      ];
    case OutOfMovesKind.Ci:
      return [
        {
          label: OutOfMovesChoice.More,
          description: `Runs the failed checks again, with up to ${count(input.more, 'more fix', 'more fixes')}`,
        },
        {
          label: OutOfMovesChoice.Change,
          description: 'The same, and the next fix carries your note',
        },
        { label: OutOfMovesChoice.Drop, description: 'Closes the pull request' },
      ];
    case OutOfMovesKind.Stall:
      return [
        {
          label: OutOfMovesChoice.More,
          description: 'Stops it and starts it once more from its handoff',
        },
        { label: OutOfMovesChoice.Change, description: 'The same, with your note in its brief' },
        { label: OutOfMovesChoice.Drop, description: 'Cancels the run' },
      ];
    case OutOfMovesKind.Run:
    case OutOfMovesKind.Recovery:
      return [
        {
          label: OutOfMovesChoice.More,
          description: `Runs the task again, with up to ${count(input.more, 'more attempt', 'more attempts')}`,
        },
        { label: OutOfMovesChoice.Change, description: 'Runs the task again with your note' },
        {
          label: OutOfMovesChoice.Drop,
          description:
            input.batchId === null
              ? "Cancels the task's run"
              : "Leaves this task out and ships the batch's finished tasks; with none finished, cancels it and abandons the batch",
        },
      ];
  }
}

/** The card's options and the detail its answers read. */
export function outOfMovesFields(input: {
  readonly kind: OutOfMovesKind;
  /** N in "up to N more". */
  readonly more: number;
  readonly batchId: BatchId | null;
  readonly workstreamId: WorkstreamId | null;
  readonly outside?: boolean;
}): { options: InboxOption[]; detail: Record<string, Json> } {
  const detail: Record<string, Json> = {
    kind: input.kind,
    more: input.more,
    batchId: input.batchId,
    workstreamId: input.workstreamId,
    ...(input.outside === undefined ? {} : { outside: input.outside }),
  };
  return { options: options(input), detail: { [OUT_OF_MOVES_DETAIL]: detail } };
}

/** What the answers do; the daemon passes the shipper's and the runner's moves. */
export interface OutOfMovesMoves {
  readonly db: DbReader;
  /** Allows `more` fix tasks for the batch's gate and ships it again. */
  moreFixes(batchId: BatchId, more: number, forceInside: boolean): void;
  /** Reopens the failed batch with one fix task whose description opens with `note`. */
  fixWithNote(batchId: BatchId, note: string, failure: string): void;
  abandon(batchId: BatchId): void;
  shipWithout(batchId: BatchId, workstreamId: WorkstreamId): void;
  retry(id: WorkstreamId, note?: string): void;
  cancel(id: WorkstreamId): Promise<void>;
  /**
   * Stops a stalled run and queues it again (`Runner.restartStalled`). Its write replaces the run's
   * restart record, so an answer never clears the record itself.
   */
  restartStalled(
    id: WorkstreamId,
    opts?: { note?: string },
  ): Promise<'restarted' | 'stop_hung' | 'not_active'>;
  /** A stop that did not finish: the run keeps its record and the card comes back. */
  stopHung(id: WorkstreamId): void;
  readonly log: Logger;
}

/**
 * Acts on an out-of-moves card's answer before the inbox records it. A refusal throws, so the card stays
 * open and the builder sees why: Change the Task without a note, and any move the shipper refuses.
 */
export function createOutOfMovesAnswers(
  deps: OutOfMovesMoves,
): (item: InboxItemDto, answer: InboxAnswer) => void {
  const cancel = (id: WorkstreamId): void => {
    if (isTerminal(getWorkstreamRow(deps.db, id).state)) return;
    deps.cancel(id).catch((error: unknown) => {
      deps.log.error({ err: error, workstreamId: id }, 'could not cancel a run out of moves');
    });
  };
  /**
   * More and Change on a stalled run's card. The hook is synchronous, so the card closes with the
   * answer; a stop that hangs again marks the record and the card is raised again.
   */
  const restart = (id: WorkstreamId, note?: string): void => {
    deps
      .restartStalled(id, note === undefined ? undefined : { note })
      .then((result) => {
        if (result === 'stop_hung') deps.stopHung(id);
      })
      .catch((error: unknown) => {
        deps.log.error({ err: error, workstreamId: id }, 'could not restart a stalled run');
        deps.stopHung(id);
      });
  };
  /** Drop It on a run's card: leave it out of its batch, or end the batch when nothing else finished. */
  const dropRun = (batchId: BatchId | null, id: WorkstreamId): void => {
    if (batchId === null) {
      cancel(id);
      return;
    }
    const others = listWorkstreams(deps.db, { batchId }).filter((m) => m.id !== id);
    if (others.some((m) => m.state === WorkstreamState.Done)) {
      deps.shipWithout(batchId, id);
      return;
    }
    // The abandon refuses first, so a refused Drop cancels nothing.
    deps.abandon(batchId);
    cancel(id);
  };
  return (item, answer) => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const parsed = OutOfMovesDetail.safeParse(item.detail?.[OUT_OF_MOVES_DETAIL]);
    if (!parsed.success) return;
    const card = parsed.data;
    const choice = answer.choice;
    if (
      choice !== OutOfMovesChoice.More &&
      choice !== OutOfMovesChoice.Change &&
      choice !== OutOfMovesChoice.Drop
    )
      return;
    const note = answer.note?.trim() ?? '';
    if (choice === OutOfMovesChoice.Change && note === '')
      throw new InboxAnswerRefused('Change the Task needs a note saying what to change');
    switch (card.kind) {
      case OutOfMovesKind.Gate: {
        if (card.batchId === null) return;
        if (choice === OutOfMovesChoice.More)
          deps.moreFixes(card.batchId, card.more, card.outside === true);
        else if (choice === OutOfMovesChoice.Change)
          deps.fixWithNote(card.batchId, note, item.body);
        else deps.abandon(card.batchId);
        return;
      }
      case OutOfMovesKind.Run:
      case OutOfMovesKind.Recovery: {
        if (card.workstreamId === null) return;
        if (choice === OutOfMovesChoice.More) deps.retry(card.workstreamId);
        else if (choice === OutOfMovesChoice.Change) deps.retry(card.workstreamId, note);
        else dropRun(card.batchId, card.workstreamId);
        return;
      }
      case OutOfMovesKind.Stall: {
        if (card.workstreamId === null) return;
        if (choice === OutOfMovesChoice.More) restart(card.workstreamId);
        else if (choice === OutOfMovesChoice.Change) restart(card.workstreamId, note);
        else cancel(card.workstreamId);
        return;
      }
      case OutOfMovesKind.Ci:
        // The pull request's card answers through the CI stop's own moves.
        return;
    }
  };
}
