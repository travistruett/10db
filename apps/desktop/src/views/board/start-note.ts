import {
  InboxKind,
  type InboxItemDto,
  type TaskDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { z } from 'zod';

/**
 * Where a Start the builder asked for has got to. The daemon answers a pull-request start at once and
 * checks git and gh in the background, so "asked" is not "started": it waits for a run to appear or
 * for the refusal's Inbox card.
 */
export type StartAttempt =
  | {
      readonly phase: 'requesting' | 'waiting';
      /** The task's run when it was asked, so a new run (a start that took) ends the wait. */
      readonly workstreamId: WorkstreamId | null;
      /** When the task's refusal card last changed before the click; a later change is this start's refusal. */
      readonly seen: string | null;
    }
  | { readonly phase: 'failed'; readonly reason: string };

/** What a card says about its Start: it is on its way, or it was refused. */
export interface StartNote {
  readonly kind: 'starting' | 'refused';
  /** One plain line for the card. */
  readonly line: string;
  /** Whether an Inbox card holds the details. */
  readonly inbox: boolean;
}

const NamesTasks = z.object({ taskIds: z.array(z.string()) });

/** The newest open flag that names each task: the daemon's card for a start it refused. */
export function refusalCards(items: readonly InboxItemDto[]): ReadonlyMap<TaskId, InboxItemDto> {
  const found = new Map<TaskId, InboxItemDto>();
  for (const item of items) {
    if (item.kind !== InboxKind.Flag) continue;
    const named = NamesTasks.safeParse(item.detail);
    if (!named.success) continue;
    for (const id of named.data.taskIds) {
      // The ids come from the daemon's own detail; they are task ids by construction.
      const taskId = id as TaskId;
      const current = found.get(taskId);
      if (!current || current.updatedAt < item.updatedAt) found.set(taskId, item);
    }
  }
  return found;
}

const STARTING: StartNote = { kind: 'starting', line: 'Starting…', inbox: false };

/**
 * The note for a card that can be started, or null when it has nothing to say: no start asked and no
 * refusal open, or the start took.
 */
export function startNote(input: {
  readonly attempt: StartAttempt | undefined;
  readonly task: TaskDto;
  readonly startable: boolean;
  readonly card: InboxItemDto | undefined;
}): StartNote | null {
  const { attempt, task, startable, card } = input;
  if (!startable) return null;
  const refused = (item: InboxItemDto): StartNote => ({
    kind: 'refused',
    line: item.title,
    inbox: true,
  });
  if (!attempt) return card ? refused(card) : null;
  switch (attempt.phase) {
    case 'requesting':
      return STARTING;
    case 'waiting':
      if (task.workstreamId !== attempt.workstreamId) return null;
      return card && card.updatedAt !== attempt.seen ? refused(card) : STARTING;
    case 'failed':
      return { kind: 'refused', line: `Not started: ${attempt.reason}`, inbox: false };
  }
}
