import {
  BatchState,
  LANE_STATES,
  WorkstreamState,
  type BatchId,
  type ProjectId,
} from '@10db/contracts';
import {
  getBatch,
  getBatchRow,
  getProject,
  listWorkstreams,
  patchBatch,
  type DbReader,
} from '@10db/db';
import type { StateStore } from '../events';
import type { CheckoutPlace, Git } from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { checkoutCards, type Card } from './cards';
import { raise } from './context';

/** What a switch back needs; startup recovery has these without a delivery context. */
export interface CheckoutReturnDeps {
  readonly state: StateStore;
  readonly git: Git;
  readonly inbox: InboxService;
  readonly logger: Logger;
}

/** What `returnCheckout` did. */
export type CheckoutReturn =
  /** No place to go back to: a worktree batch, an unfinished one, or one already handled. */
  | 'nothing'
  | 'switched'
  /** Left as it is: the builder moved it off the batch's branch on purpose, so no card. */
  | 'moved'
  /** Left as it is, with a card saying why. */
  | 'left';

const FINISHED: readonly BatchState[] = [
  BatchState.Shipped,
  BatchState.Closed,
  BatchState.Abandoned,
];

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Workstreams of the project with work in hand, counted as Abandon counts them. */
function runningIn(db: DbReader, projectId: ProjectId): number {
  return listWorkstreams(db, { projectId }).filter(
    (w) =>
      LANE_STATES.includes(w.state) ||
      w.state === WorkstreamState.TakenOver ||
      (w.state === WorkstreamState.WaitingHuman && w.currentSessionId !== null),
  ).length;
}

/**
 * After a shared batch ships, closes or is abandoned: switches the builder's checkout back to where
 * the cut found it, but only while it is still on the batch's branch, nothing in it is uncommitted,
 * no ignored file is in the way and no work runs in the project. Otherwise the checkout is left as
 * it is, with a card unless the builder moved it themselves. Either way the place is then
 * forgotten, so it is tried once. Safe to repeat.
 */
export async function returnCheckout(
  deps: CheckoutReturnDeps,
  batchId: BatchId,
): Promise<CheckoutReturn> {
  const db = deps.state.db;
  const row = getBatchRow(db, batchId);
  if (!FINISHED.includes(row.state) || row.returnSha === null || row.branch === null)
    return 'nothing';
  const batch = getBatch(db, batchId);
  const project = getProject(db, row.projectId);
  const place: CheckoutPlace = { branch: row.returnBranch, sha: row.returnSha };
  const log = { batchId, projectId: project.id, branch: row.branch, to: place };
  const forget = (): void => {
    deps.state.write((w) => patchBatch(w, batchId, { returnBranch: null, returnSha: null }));
  };
  const leave = (card: Card): CheckoutReturn => {
    forget();
    raise(deps.inbox, project.id, card);
    deps.logger.info({ ...log, title: card.title }, 'checkout left on the batch branch');
    return 'left';
  };

  const running = runningIn(db, project.id);
  if (running > 0) return leave(checkoutCards.lanesRunning(batch, project, place, running));
  try {
    const outcome = await deps.git.switchBack(project.repoPath, row.branch, place);
    switch (outcome.kind) {
      case 'switched':
        forget();
        deps.logger.info(log, 'checkout switched back');
        return 'switched';
      case 'moved':
        forget();
        deps.logger.info(
          { ...log, found: outcome.found },
          'checkout already moved off the batch branch',
        );
        return 'moved';
      case 'dirty':
        return leave(checkoutCards.dirty(batch, project, place, outcome.paths));
      case 'ignored':
        return leave(checkoutCards.ignored(batch, project, place, outcome.paths));
      case 'checked_out':
        return leave(checkoutCards.checkedOut(batch, place, outcome.path));
      case 'gone':
        return leave(checkoutCards.gone(batch, project, place));
    }
  } catch (error) {
    // A git refusal raised its own trust card, which says why; this one says the checkout stays.
    deps.logger.warn({ ...log, err: message(error) }, 'checkout not switched back');
    return leave(checkoutCards.failed(batch, project, place, error));
  }
}
