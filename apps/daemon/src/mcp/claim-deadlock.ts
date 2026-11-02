import {
  ClaimKind,
  InboxKind,
  isTerminal,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type WorkstreamId,
} from '@10db/contracts';
import { activeClaims, getWorkstreamRow, releaseClaim, type Json } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import type { ClaimWaits } from './claim-wait';

/** Where a deadlock card keeps what each of its answers does. */
const DEADLOCK_DETAIL = 'deadlock';

const DeadlockChoice = z.object({
  label: z.string(),
  action: z.enum(['yield', 'cancel']),
  workstreamId: z.string(),
  /** The claims a yield gives up; a cancel frees everything the task holds. */
  claims: z.array(z.object({ kind: z.enum(ClaimKind), name: z.string() })),
});
type DeadlockChoice = z.infer<typeof DeadlockChoice>;

const DeadlockDetail = z.object({ choices: z.array(DeadlockChoice) });

export interface DeadlockTask {
  readonly workstreamId: WorkstreamId;
  readonly title: string;
  /** What this task gives up when it yields: the claims it holds that the others wait for. */
  readonly yields: readonly { readonly kind: ClaimKind; readonly name: string }[];
}

/**
 * The answers a claim deadlock card offers, and what the daemon does for each: every task in the
 * deadlock can yield its claim (so the other gets it) or be cancelled (which frees all it holds).
 * Tasks of the same title are told apart by their workstream.
 */
export function deadlockAnswers(tasks: readonly DeadlockTask[]): {
  readonly options: InboxOption[];
  readonly detail: Record<string, Json>;
} {
  const sameTitle = (t: DeadlockTask): boolean =>
    tasks.filter((o) => o.title === t.title).length > 1;
  const named = (t: DeadlockTask): string =>
    sameTitle(t) ? `${t.title} (${t.workstreamId})` : t.title;
  const claimsOf = (t: DeadlockTask): string =>
    t.yields.map((c) => `${c.kind} ${c.name}`).join(', ');
  const choices: { choice: DeadlockChoice; description: string }[] = [];
  for (const t of tasks)
    choices.push({
      choice: {
        label: `${named(t)} yields ${claimsOf(t)}`,
        action: 'yield',
        workstreamId: t.workstreamId,
        claims: [...t.yields],
      },
      description: `Task "${t.title}" gives up ${claimsOf(t)} so the other task gets it. It asks for it again before editing there.`,
    });
  for (const t of tasks)
    choices.push({
      choice: {
        label: `Cancel ${named(t)}`,
        action: 'cancel',
        workstreamId: t.workstreamId,
        claims: [],
      },
      description: `Ends task "${t.title}" and frees every claim it holds, so the other task goes on.`,
    });
  return {
    options: choices.map(({ choice, description }) => ({ label: choice.label, description })),
    detail: { [DEADLOCK_DETAIL]: { choices: choices.map((c) => c.choice) } },
  };
}

/**
 * Acts on the builder's answer to a claim deadlock card, before the card records it. A yield releases
 * the claims the card named for that task and ends its wait with a refusal naming them, so its agent
 * learns it lost them before it edits there again; the other task's wait, which waits on the card,
 * then takes the claim. A cancel ends the task unless it already ended. Any other card, and any other
 * answer, is left alone.
 */
export function createClaimDeadlockAnswers(deps: {
  readonly state: StateStore;
  /** Ends the workstream's session (if any) and marks it cancelled, as a cancel from the Board does. */
  cancel(id: WorkstreamId): Promise<void>;
  /** The MCP handler's claim waits, which end the yielding task's wait and tell its agent. */
  readonly waits: ClaimWaits;
  readonly log: Logger;
}): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    if (item.kind !== InboxKind.Flag) return;
    const detail = DeadlockDetail.safeParse(item.detail?.[DEADLOCK_DETAIL]);
    if (!detail.success) return;
    const choice = detail.data.choices.find((c) => c.label === answer.choice);
    if (!choice) return;
    const id = choice.workstreamId as WorkstreamId;
    if (choice.action === 'yield') {
      // The task is told through its wait, so a claim is released only from a task that waits: one
      // that does not is in no deadlock, and losing a claim untold would let two tasks edit one area.
      if (!deps.waits.yielded(id, { claims: choice.claims, inboxId: item.id })) {
        deps.log.warn(
          { workstreamId: id, inboxId: item.id },
          'a claim deadlock answer named a task that no longer waits; nothing was released',
        );
        return;
      }
      deps.state.write((ctx) => {
        for (const claim of activeClaims(ctx.tx, id))
          if (choice.claims.some((c) => c.kind === claim.kind && c.name === claim.name))
            releaseClaim(ctx, claim.id);
      });
      return;
    }
    if (isTerminal(getWorkstreamRow(deps.state.db, id).state)) return;
    deps.waits.cancelled(id);
    deps.cancel(id).catch((error: unknown) => {
      deps.log.error(
        { err: error, workstreamId: id },
        'could not cancel a task in a claim deadlock',
      );
    });
  };
}
