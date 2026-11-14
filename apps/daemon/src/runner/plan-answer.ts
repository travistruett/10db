import {
  ConflictError,
  InvalidError,
  PlanChoice,
  type InboxAnswer,
  type InboxItemDto,
} from '@10db/contracts';
import { getWorkstreamRow, type WriteContext } from '@10db/db';
import type { AfterCommit, Runner } from './runner';

function choiceOf(answer: InboxAnswer): PlanChoice {
  const known = Object.values(PlanChoice).find((c) => c === answer.choice);
  if (!known) throw new InvalidError(`"${answer.choice}" is not a choice on a plan card`);
  return known;
}

/**
 * Acts on the builder's answer to a plan card for every workstream it targets, inside the write that
 * closes the card. A workstream that no longer waits on this very card refuses it, so a stale answer
 * starts nothing. Returns what has to run once that write has committed.
 */
export function applyPlanAnswer(
  runner: Runner,
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): AfterCommit {
  const choice = choiceOf(answer);
  const afterCommit: AfterCommit[] = [];
  for (const target of item.targets) {
    const { nextAction } = getWorkstreamRow(ctx.tx, target.workstreamId);
    if (nextAction.kind !== 'plan_approval' || nextAction.inboxId !== item.id)
      throw new ConflictError(`Workstream ${target.workstreamId} is not waiting on this plan card`);
    switch (choice) {
      case PlanChoice.Approve:
        afterCommit.push(runner.approvePlan(ctx, target.workstreamId));
        break;
      case PlanChoice.SendBack:
        afterCommit.push(runner.sendBackPlan(ctx, target.workstreamId, answer.note ?? ''));
        break;
    }
  }
  return () => {
    for (const run of afterCommit) run();
  };
}
