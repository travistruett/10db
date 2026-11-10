import {
  CheckChoice,
  ConflictError,
  DomainError,
  InvalidError,
  PASS_SIGN_OFF_CHOICE,
  type InboxAnswer,
  type InboxItemDto,
  type PassDto,
} from '@10db/contracts';
import {
  getTask,
  getWorkstreamRow,
  passHoldingTask,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { AfterCommit, Runner } from './runner';

/**
 * A check card was answered before the runner existed; the answer is refused, not dropped. It carries
 * the conflict code, so the API answers 409.
 */
export class RunnerNotStartedError extends DomainError {
  override readonly name = 'RunnerNotStartedError';
  constructor() {
    super('conflict', 'The runner has not started, so the check cannot be answered yet');
  }
}

function choiceOf(answer: InboxAnswer): CheckChoice {
  const known = Object.values(CheckChoice).find((c) => c === answer.choice);
  if (!known) throw new InvalidError(`"${answer.choice}" is not a choice on a check card`);
  return known;
}

/** The pass holding the task of one of the card's workstreams, if any: its card is a Ready page's. */
function passOfCard(db: DbReader, item: InboxItemDto): PassDto | undefined {
  for (const target of item.targets) {
    const pass = passHoldingTask(db, getTask(db, getWorkstreamRow(db, target.workstreamId).taskId));
    if (pass) return pass;
  }
  return undefined;
}

/** Signs off a Ready page; a page is signed off as its pass closes, which is not built yet. */
function signOffPage(): never {
  throw new ConflictError('Sign off comes with closing the pass');
}

/**
 * Acts on the builder's answer to a check card for every workstream it targets, inside the write
 * that closes the card. Returns what has to run once that write has committed. A page of a pass is
 * signed off, never approved or sent back: an attempt is never spent on it.
 */
export function applyCheckAnswer(
  runner: Runner,
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): AfterCommit {
  const pass = passOfCard(ctx.tx, item);
  if (pass) {
    if (answer.choice === PASS_SIGN_OFF_CHOICE) signOffPage();
    throw new ConflictError(
      `A page of Workbench pass "${pass.name}" is signed off, not approved or sent back`,
    );
  }
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
