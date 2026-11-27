import {
  ClaimKind,
  clipText,
  INBOX_OPTION_LABEL_MAX,
  InboxAnswerRefused,
  InboxKind,
  isTerminal,
  type InboxAnswer,
  type InboxItemDto,
  type InboxItemId,
  type InboxOption,
  type WorkstreamId,
} from '@10db/contracts';
import { activeClaims, getWorkstreamRow, releaseClaim, type Json } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { withdrawCard } from '../inbox';
import type { Logger } from '../log';
import type { ClaimWaits } from './claim-wait';

/** Where a deadlock card keeps what each of its answers does. */
export const DEADLOCK_DETAIL = 'deadlock';

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

/** The start of a title a label always keeps; tasks whose titles share it are told apart by number. */
const TITLE_KEPT = 32;
/** The longest number tag a label gives a task, ` (task 99)`. */
const TAG_ROOM = 10;
const YIELDS = ' yields ';
const CANCEL = 'Cancel ';

/**
 * The answers a claim deadlock card offers, and what the daemon does for each: every task in the
 * deadlock can yield its claim (so the other gets it) or be cancelled (which frees all it holds).
 * A label fits on the card's button, so a long title is cut; the description names the whole title.
 * Tasks whose titles start alike are told apart by number, and their descriptions name the workstream.
 */
export function deadlockAnswers(tasks: readonly DeadlockTask[]): {
  readonly options: InboxOption[];
  readonly detail: Record<string, Json>;
} {
  const lookAlike = (t: DeadlockTask): boolean =>
    tasks.some((o) => o !== t && o.title.slice(0, TITLE_KEPT) === t.title.slice(0, TITLE_KEPT));
  const named = (t: DeadlockTask, room: number): string => {
    const tag = lookAlike(t) ? ` (task ${String(tasks.indexOf(t) + 1)})` : '';
    return `${clipText(t.title, room - tag.length)}${tag}`;
  };
  const whole = (t: DeadlockTask): string =>
    lookAlike(t) ? `"${t.title}" (${t.workstreamId})` : `"${t.title}"`;
  const claimsOf = (t: DeadlockTask): string =>
    t.yields.map((c) => `${c.kind} ${c.name}`).join(', ');
  const choices: { choice: DeadlockChoice; description: string }[] = [];
  // A task with nothing to give up (the waits changed since the deadlock was found) gets no yield:
  // choosing it would release nothing.
  for (const t of tasks.filter((o) => o.yields.length > 0)) {
    const claims = clipText(
      claimsOf(t),
      INBOX_OPTION_LABEL_MAX - YIELDS.length - TITLE_KEPT - TAG_ROOM,
    );
    choices.push({
      choice: {
        label: `${named(t, INBOX_OPTION_LABEL_MAX - YIELDS.length - claims.length)}${YIELDS}${claims}`,
        action: 'yield',
        workstreamId: t.workstreamId,
        claims: [...t.yields],
      },
      description: `Task ${whole(t)} gives up ${claimsOf(t)} so the other task gets it. It asks for it again before editing there. Edits it has not committed there stay as they are and remain its own: the other task is not asked to commit them, and this task commits them after it gets ${claimsOf(t)} back.`,
    });
  }
  for (const t of tasks)
    choices.push({
      choice: {
        label: `${CANCEL}${named(t, INBOX_OPTION_LABEL_MAX - CANCEL.length)}`,
        action: 'cancel',
        workstreamId: t.workstreamId,
        claims: [],
      },
      description: `Ends task ${whole(t)} and frees every claim it holds, so the other task goes on. Its uncommitted edits stay in its folder as they are; the other task is not asked to commit them.`,
    });
  return {
    options: choices.map(({ choice, description }) => ({ label: choice.label, description })),
    detail: { [DEADLOCK_DETAIL]: { choices: choices.map((c) => c.choice) } },
  };
}

function refuseEnded(deps: { readonly state: StateStore }, inboxId: InboxItemId): never {
  deps.state.write((ctx) => {
    withdrawCard(ctx, inboxId);
  });
  throw new InboxAnswerRefused(
    'This claim deadlock has already ended: neither task waits on it any more, so nothing was changed. The card was withdrawn.',
  );
}

/**
 * Acts on the builder's answer to a claim deadlock card, before the card records it. A yield releases
 * the claims the card named for that task and ends its wait with a refusal naming them, so its agent
 * learns it lost them before it edits there again; the other task's wait, which waits on the card,
 * then takes the claim. A cancel ends the task unless it already ended. An answer to a card no wait
 * waits on any more is refused, and the card withdrawn: its deadlock ended. Any other card, and any other
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
    // The waits that raised the card ended (a session stopped, or the daemon restarted), so the
    // deadlock it asks about is gone: a yield would free nothing and a cancel would end a task for
    // nothing. The card goes, and the builder is told the answer was not applied.
    if (!deps.waits.awaitsCard(item.id)) refuseEnded(deps, item.id);
    if (choice.action === 'yield') {
      // A task that already ended has nothing to give up, and its terminal event has passed, so
      // nothing would ever drop the yield: it would outlive the daemon's run and answer a retry.
      if (isTerminal(getWorkstreamRow(deps.state.db, id).state)) return;
      // The task is told through its wait, so a claim is released only from a task that waits: one
      // that does not is in no deadlock, and losing a claim untold would let two tasks edit one area.
      if (!deps.waits.yielded(id, { claims: choice.claims, inboxId: item.id }))
        refuseEnded(deps, item.id);
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
