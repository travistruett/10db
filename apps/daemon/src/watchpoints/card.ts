import {
  InboxKind,
  InboxState,
  WatchpointChoice,
  WatchpointCardDetail,
  WatchpointLoudness,
  type InboxAnswer,
  type InboxItemDto,
  type ProjectId,
  type TaskId,
  type WatchpointDetail,
  type WatchpointHit,
  type WorkstreamId,
} from '@10db/contracts';
import {
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
  const asks = hitsAt(input.detail, WatchpointLoudness.Ask);
  if (asks.length > 0) raiseWatchpointCard(ctx, { ...input, asks });
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
  const body = [
    `The change touched ${labelsOf(input.asks)}, which you asked to look at yourself.`,
    '',
    'Looks right closes this card. Send it back with a note to file a follow-up task.',
  ].join('\n');
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
