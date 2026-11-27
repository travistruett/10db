import {
  CARD_RESOLUTION,
  InboxKind,
  InboxState,
  WatchpointChoice,
  WatchpointCardDetail,
  WatchpointLoudness,
  type CardResolution,
  type InboxAnswer,
  type InboxItemDto,
  type ProjectId,
  type TaskId,
  type WatchpointDetail,
  type WatchpointHit,
  type WorkstreamId,
} from '@10db/contracts';
import {
  answeredItemsForWorkstream,
  getWorkstreamRow,
  insertInboxItem,
  insertWatchpointFollowUp,
  openItemsForWorkstream,
  updateInboxItem,
  type WriteContext,
} from '@10db/db';
import { CardTier, postNotice } from '../inbox';

const hitsAt = (detail: WatchpointDetail | null, loudness: WatchpointLoudness): WatchpointHit[] =>
  detail?.hits.filter((h) => h.watchpoint.loudness === loudness) ?? [];

const labelsOf = (hits: readonly WatchpointHit[]): string =>
  hits.map((h) => h.watchpoint.label).join(', ');

/** Why a review must follow a run whose change hit a watchpoint set to ask; null when none did. */
export function watchpointReviewReason(detail: WatchpointDetail | null): string | null {
  const asks = hitsAt(detail, WatchpointLoudness.Ask);
  return asks.length === 0 ? null : `a watchpoint asks for you: ${labelsOf(asks)}`;
}

/**
 * Tells the builder what a run's reading hit, inside the write that records it. Ask hits raise the workstream's one
 * Look card (a second reading updates it); show hits post one notice. The run never waits on either.
 */
export function announceWatchpointReading(
  ctx: WriteContext,
  input: {
    workstreamId: WorkstreamId;
    projectId: ProjectId;
    taskId: TaskId;
    taskTitle: string;
    detail: WatchpointDetail | null;
  },
): void {
  const looked = lookedAt(ctx, input.workstreamId);
  const asks = hitsAt(input.detail, WatchpointLoudness.Ask).filter(
    (h) => !looked.has(h.watchpoint.key),
  );
  if (asks.length > 0) raiseWatchpointCard(ctx, { ...input, asks });
  else if (input.detail?.skipped === null) withdrawLiveCard(ctx, input.workstreamId);
  const shows = hitsAt(input.detail, WatchpointLoudness.Show);
  if (shows.length > 0)
    postNotice(ctx, {
      tier: CardTier.Notice,
      projectId: input.projectId,
      taskId: input.taskId,
      key: `watchpoint:${input.workstreamId}`,
      tone: 'info',
      line: `${input.taskTitle} touched ${labelsOf(shows)}`,
      body: shows
        .map((h) => `${h.watchpoint.label}: ${h.files.map((f) => f.path).join(', ')}`)
        .join('\n'),
    });
}

/**
 * The watchpoints the builder already answered a Look card of the workstream about: a later reading of the same
 * run doesn't ask again. A card 10db withdrew has no answer, so a change that comes back is asked about again.
 */
function lookedAt(ctx: WriteContext, workstreamId: WorkstreamId): Set<string> {
  const keys = new Set<string>();
  for (const card of answeredItemsForWorkstream(ctx.tx, workstreamId, InboxKind.Watchpoint)) {
    if (!card.answer) continue;
    const detail = WatchpointCardDetail.safeParse(card.detail);
    if (detail.success) for (const w of detail.data.watchpoints) keys.add(w.key);
  }
  return keys;
}

/** A later reading with nothing to ask about closes the card the earlier one left, as 10db's own withdrawal. */
function withdrawLiveCard(ctx: WriteContext, workstreamId: WorkstreamId): void {
  const live = openItemsForWorkstream(ctx.tx, workstreamId).find(
    (item) => item.kind === InboxKind.Watchpoint && item.state === InboxState.Open,
  );
  if (live === undefined) return;
  const resolution: CardResolution = { by: '10db', reason: 'The change no longer touches it.' };
  updateInboxItem(ctx, live.id, {
    state: InboxState.Resolved,
    detail: { ...live.detail, [CARD_RESOLUTION]: resolution },
  });
}

function raiseWatchpointCard(
  ctx: WriteContext,
  input: {
    workstreamId: WorkstreamId;
    projectId: ProjectId;
    taskTitle: string;
    asks: readonly WatchpointHit[];
  },
): void {
  const detail = {
    watchpoints: input.asks.map((h) => ({ key: h.watchpoint.key, label: h.watchpoint.label })),
  };
  // The card's bar offers Looks Right and Send Back, so the summary says only what the change touched.
  const body = `The change touched ${labelsOf(input.asks)}, which you asked to look at yourself.`;
  const live = openItemsForWorkstream(ctx.tx, input.workstreamId).find(
    (item) => item.kind === InboxKind.Watchpoint && item.state === InboxState.Open,
  );
  if (live) {
    updateInboxItem(ctx, live.id, { body, detail });
    return;
  }
  insertInboxItem(ctx, {
    projectId: input.projectId,
    kind: InboxKind.Watchpoint,
    title: `Look at these changes: ${input.taskTitle}`,
    body,
    options: [
      { label: WatchpointChoice.LooksRight, description: 'The changes are right as they are' },
      { label: WatchpointChoice.SendBack, description: 'Send it back with a note' },
    ],
    recommendation: null,
    category: 'product',
    urgency: 'normal',
    detail,
    foldKey: null,
    targets: [{ workstreamId: input.workstreamId, sessionId: null }],
  });
}

/**
 * Acts on the answer to a Look card inside the write that closes it. Looks right changes nothing. Send back files
 * one Ready follow-up task for the watchpoints the card named, holding the builder's note.
 */
export function applyWatchpointAnswer(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: Pick<InboxAnswer, 'choice' | 'note'>,
): void {
  if (answer.choice !== WatchpointChoice.SendBack) return;
  const target = item.targets[0];
  if (!target) return;
  const detail = WatchpointCardDetail.safeParse(item.detail);
  const labels = detail.success ? detail.data.watchpoints.map((w) => w.label) : [];
  const taskId = getWorkstreamRow(ctx.tx, target.workstreamId).taskId;
  insertWatchpointFollowUp(ctx, taskId, { watchpoints: labels, note: (answer.note ?? '').trim() });
}
