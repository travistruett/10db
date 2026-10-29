import { CheckChoice, InvalidError, type InboxAnswer, type InboxItemDto } from '@10db/contracts';
import type { WriteContext } from '@10db/db';
import type { AfterCommit, Runner } from './runner';

/** A check card was answered before the runner existed; the answer is refused, not dropped. */
export class RunnerNotStartedError extends Error {
  override readonly name = 'RunnerNotStartedError';
  constructor() {
    super('The runner has not started, so the check cannot be answered yet');
  }
}

function choiceOf(answer: InboxAnswer): CheckChoice {
  const known = Object.values(CheckChoice).find((c) => c === answer.choice);
  if (!known) throw new InvalidError(`"${answer.choice}" is not a choice on a check card`);
  return known;
}

/**
 * Acts on the builder's answer to a check card for every workstream it targets, inside the write
 * that closes the card. Returns what has to run once that write has committed.
 */
export function applyCheckAnswer(
  runner: Runner,
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): AfterCommit {
  const choice = choiceOf(answer);
  const afterCommit: AfterCommit[] = [];
  for (const target of item.targets) {
    switch (choice) {
      case CheckChoice.Approve:
        afterCommit.push(runner.approveCheck(ctx, target.workstreamId));
        break;
      case CheckChoice.SendBack:
        afterCommit.push(runner.sendBack(ctx, target.workstreamId, answer.note ?? ''));
        break;
    }
  }
  return () => {
    for (const run of afterCommit) run();
  };
}
