import {
  CARD_RESOLUTION,
  EvidenceKind,
  InboxKind,
  InboxState,
  WatchpointCardDetail,
  WorkstreamState,
  type BatchDto,
  type CardResolution,
  type InboxAnswer,
  type InboxItemDto,
  type WatchpointDetail,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getBatch,
  getTask,
  getWorkstreamRow,
  isLocalCopy,
  listEvidence,
  listWorkstreams,
  openItemsForWorkstream,
  updateInboxItem,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import {
  applyWatchpointAnswer,
  holdingHits,
  mergeApproval,
  raiseLookCard,
  WatchpointHoldAction,
  type HeldLanding,
} from '../watchpoints';
import { members, leftOut } from './batch-members';
import { patchCiOutOfMoves, fixesOf } from './ci-stop';
import type { DeliveryContext } from './context';
import { holdRootOf } from './guardrail-hold';
import { closeHeldPullRequest, type GuardrailHoldArming } from './guardrail-hold-card';

/**
 * A pull request that holds a change to a watchpoint set to Hold is never armed or merged by 10db until the builder
 * answers Merge for that change. Nothing about the hold is stored: it is read from each task's newest watchpoint
 * reading and the Look cards the builder answered, so a restart, a catch-up or a retry derives the same answer.
 */

/** One task of the pull request whose change hits a watchpoint that holds it, and its Look card. */
export interface WaitingTask {
  readonly workstreamId: WorkstreamId;
  readonly taskTitle: string;
  /** The labels of the watchpoints holding the pull request for this task. */
  readonly labels: string[];
  /** Whether the task's Look card is open and says it holds the pull request. */
  readonly cardOpen: boolean;
  /** The pull request URL that card carries; null when it carries none. */
  readonly cardPrUrl: string | null;
  /** The reading the card is raised from. */
  readonly detail: WatchpointDetail;
}

/** Whether a landing can be held: its batch delivers by pull request, not as a pass's pull request or a local copy. */
export function canHoldLanding(db: DbReader, batch: BatchDto): boolean {
  return batch.passId == null && !isLocalCopy(db, batch.id);
}

/** The root batch and its CI-fix batches: every batch whose commits land on the root's pull request branch. */
function landingBatches(db: DbReader, root: BatchDto): BatchDto[] {
  return [root, ...fixesOf(db, root)];
}

/**
 * The task's current reading: the newest one that was read at all. A later skipped or unreadable reading never
 * releases an earlier one, so it is passed over.
 */
function currentReading(db: DbReader, workstreamId: WorkstreamId): WatchpointDetail | null {
  for (const row of listEvidence(db, workstreamId).reverse())
    if (row.kind === EvidenceKind.Watchpoint && row.detail.skipped === null) return row.detail;
  return null;
}

/** A workstream's open Look card, and what it says about the pull request it holds. */
function heldCardOf(
  db: DbReader,
  workstreamId: WorkstreamId,
): { readonly item: InboxItemDto; readonly prUrl: string | null } | null {
  for (const item of openItemsForWorkstream(db, workstreamId)) {
    if (item.kind !== InboxKind.Watchpoint || item.state !== InboxState.Open) continue;
    const held = WatchpointCardDetail.safeParse(item.detail).data?.held;
    if (held !== undefined) return { item, prUrl: held.prUrl };
  }
  return null;
}

/**
 * Whether the root's pull request is held for the builder by a watchpoint, and which tasks wait. A task waits when
 * it is a member of the root or one of its CI-fix batches (not cancelled or left out) and its current reading has a
 * holding hit that no answered Merge card released for that hit's diff. A hit whose diff could not be read has no
 * hash, so nothing releases it.
 */
export function watchpointHoldOf(
  db: DbReader,
  root: BatchDto,
): { held: boolean; waiting: WaitingTask[] } {
  const waiting: WaitingTask[] = [];
  for (const batch of landingBatches(db, root)) {
    for (const member of members(db, batch.id)) {
      if (member.state === WorkstreamState.Cancelled || leftOut(member)) continue;
      const detail = currentReading(db, member.id);
      if (detail === null) continue;
      const released = mergeApproval(db, member.id);
      const hits = holdingHits(detail).filter((hit) => !released(hit));
      if (hits.length === 0) continue;
      const card = heldCardOf(db, member.id);
      waiting.push({
        workstreamId: member.id,
        taskTitle: getTask(db, member.taskId).title,
        labels: hits.map((hit) => hit.watchpoint.label),
        cardOpen: card !== null,
        cardPrUrl: card?.prUrl ?? null,
        detail,
      });
    }
  }
  return { held: waiting.length > 0, waiting };
}

/**
 * Where a run's change lands when that landing can be held: its pull request's root batch and URL, and the other
 * tasks waiting in it. Null for a pass's pull request and a local copy, and for a run with no batch.
 */
export function heldLandingOf(db: DbReader, workstreamId: WorkstreamId): HeldLanding | null {
  const { batchId } = getWorkstreamRow(db, workstreamId);
  if (batchId === null) return null;
  const batch = getBatch(db, batchId);
  if (!canHoldLanding(db, batch)) return null;
  const root = getBatch(db, holdRootOf(batch));
  return {
    batchId: root.id,
    prUrl: root.prUrl,
    alsoWaiting: watchpointHoldOf(db, root)
      .waiting.filter((w) => w.workstreamId !== workstreamId)
      .map((w) => w.taskTitle),
  };
}

const resolvedBy10db = (reason: string): CardResolution => ({ by: '10db', reason });

function withdrawHeldCard(w: WriteContext, card: InboxItemDto, reason: string): void {
  updateInboxItem(w, card.id, {
    state: InboxState.Resolved,
    detail: { ...card.detail, [CARD_RESOLUTION]: resolvedBy10db(reason) },
  });
}

/**
 * Makes sure every task waiting on the root's pull request has its Look card open and carrying the pull request's
 * URL, and that a task that no longer holds it (cancelled, left out or read clean since) has none. Run after each
 * read of the hold: held always means a card is open, a restart included. A card the builder answered Send Back on,
 * or resolved by hand, is raised again, since the hit is still unreleased.
 */
export function ensureHeldCards(w: WriteContext, root: BatchDto, prUrl: string | null): void {
  const hold = watchpointHoldOf(w.tx, root);
  const url = prUrl ?? root.prUrl;
  for (const task of hold.waiting) {
    if (task.cardOpen && (url === null || task.cardPrUrl === url)) continue;
    const workstream = getWorkstreamRow(w.tx, task.workstreamId);
    raiseLookCard(w, {
      workstreamId: task.workstreamId,
      projectId: root.projectId,
      taskTitle: task.taskTitle,
      detail: task.detail,
      landing: {
        batchId: root.id,
        prUrl: url ?? task.cardPrUrl,
        alsoWaiting: hold.waiting
          .filter((other) => other.workstreamId !== workstream.id)
          .map((other) => other.taskTitle),
      },
    });
  }
  const waiting = new Set(hold.waiting.map((task) => task.workstreamId));
  for (const batch of landingBatches(w.tx, root))
    for (const workstream of listWorkstreams(w.tx, { batchId: batch.id })) {
      if (waiting.has(workstream.id)) continue;
      const card = heldCardOf(w.tx, workstream.id);
      if (card !== null)
        withdrawHeldCard(w, card.item, 'The change no longer holds the pull request.');
    }
}

/** Withdraws the root's held Look cards, inside the write that records its pull request merged or closed. */
export function withdrawHeldCards(w: WriteContext, root: BatchDto): void {
  for (const batch of landingBatches(w.tx, root))
    for (const workstream of listWorkstreams(w.tx, { batchId: batch.id })) {
      const card = heldCardOf(w.tx, workstream.id);
      if (card !== null) withdrawHeldCard(w, card.item, 'The pull request is merged or closed.');
    }
}

/**
 * Acts on a Look card's answer inside the write that closes it, and says what follows the commit. Merge is the
 * release itself, so nothing is written for it; once it committed the pull request is read and armed, or, with no
 * pull request yet, left for the ship. Send Back closes the pull request: the drop is marked in this write so the
 * watch raises no closed card, and GitHub is asked once it committed.
 */
export function createWatchpointHoldAnswers(
  ctx: DeliveryContext,
  shipper: GuardrailHoldArming,
): {
  onAnswerInWrite(
    w: WriteContext,
    item: InboxItemDto,
    answer: Pick<InboxAnswer, 'choice' | 'note'>,
  ): (() => void) | undefined;
} {
  return {
    onAnswerInWrite(w, item, answer) {
      const effect = applyWatchpointAnswer(w, item, answer);
      if (effect === undefined) return undefined;
      switch (effect.action) {
        case WatchpointHoldAction.Arm: {
          const { rootId, prUrl } = effect;
          return prUrl === null
            ? undefined
            : () => {
                shipper.armApproved(rootId, prUrl);
              };
        }
        case WatchpointHoldAction.Close: {
          const { rootId, prUrl } = effect;
          patchCiOutOfMoves(w, rootId, { dropped: true });
          return () => {
            closeHeldPullRequest(ctx, rootId, prUrl);
          };
        }
      }
    },
  };
}
