import {
  CARD_RESOLUTION,
  InboxAnswerRefused,
  InboxKind,
  InboxState,
  KnowledgeScope,
  SourceKind,
  WatchpointChoice,
  WatchpointCardDetail,
  WatchpointLoudness,
  WatchpointReadVerdict,
  type BatchId,
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
  BUILDER_HANDLE,
  getBatch,
  getTask,
  getWorkstreamRow,
  insertDecision,
  insertInboxItem,
  insertSource,
  insertWatchpointFollowUp,
  openItemsForWorkstream,
  updateInboxItem,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { CardTier, postNotice } from '../inbox';
import { quotedWords } from '../knowledge';
import { holdingHits, holdsMerge } from './read';

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
 * Where a run's change lands when the landing can be held: the root batch of its pull request, the pull request's URL
 * once it is open, and the titles of the other tasks whose Look cards wait for the same pull request.
 */
export interface HeldLanding {
  readonly batchId: BatchId;
  readonly prUrl: string | null;
  readonly alsoWaiting: readonly string[];
}

/** What a Look card's body says when the landing is a pass's pull request or a local copy, which are not held yet. */
const CANT_HOLD = "This landing can't be held yet, so the change may already be merged.";
/** Said on a held card before its pull request is open, so Send Back is not answered expecting a pull request to close. */
const NO_PULL_REQUEST_YET =
  'The pull request is not open yet. The ship opens it held, and this card comes back with its link; Send Back now only files the task, and answering again files another.';
const UNREADABLE_DIFF =
  "10db could not read this whole diff, so it can't approve it. Merge the pull request on GitHub, or send it back.";

/**
 * Tells the builder what a run's reading hit, inside the write that records it. Ask hits raise the workstream's one
 * Look card (a second reading updates it), and so do hits that hold the pull request when the landing can be held
 * (`landing`); show hits post one notice. The run never waits on either.
 */
export function announceWatchpointReading(
  ctx: WriteContext,
  input: {
    workstreamId: WorkstreamId;
    projectId: ProjectId;
    taskId: TaskId;
    taskTitle: string;
    detail: WatchpointDetail | null;
    landing: HeldLanding | null;
  },
): void {
  raiseLookCard(ctx, input);
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
function lookedAt(db: DbReader, workstreamId: WorkstreamId): Set<string> {
  const keys = new Set<string>();
  for (const card of answeredItemsForWorkstream(db, workstreamId, InboxKind.Watchpoint)) {
    if (!card.answer) continue;
    const detail = WatchpointCardDetail.safeParse(card.detail);
    if (detail.success) for (const w of detail.data.watchpoints) keys.add(w.key);
  }
  return keys;
}

/**
 * Whether a hit that holds a pull request was released by the builder: an answered Look card of the workstream with
 * Merge whose entry for the watchpoint carries the hit's hash. A hit with no hash (its diff could not be read in
 * full) is released by nothing here.
 */
export function mergeApproval(
  db: DbReader,
  workstreamId: WorkstreamId,
): (hit: WatchpointHit) => boolean {
  const approved = new Set<string>();
  for (const card of answeredItemsForWorkstream(db, workstreamId, InboxKind.Watchpoint)) {
    if (card.answer?.choice !== WatchpointChoice.Merge) continue;
    const detail = WatchpointCardDetail.safeParse(card.detail);
    if (!detail.success) continue;
    for (const w of detail.data.watchpoints)
      if (w.hash !== undefined) approved.add(JSON.stringify([w.key, w.hash]));
  }
  return (hit) =>
    hit.hash !== undefined && approved.has(JSON.stringify([hit.watchpoint.key, hit.hash]));
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

/**
 * Gives the workstream its one Look card for a reading, or updates the one it has, or closes it when the reading
 * leaves nothing to look at (a skipped reading closes nothing: it says nothing about the change). The hits it names
 * are the Ask hits not looked at, and the hits that hold the pull request (`landing`) not released by a Merge for
 * their diff. A card with a holding hit carries `held` and offers Merge and Send Back; any other offers Looks Right
 * and Send Back, and says so when a Hold hit has no landing that can be held.
 */
export function raiseLookCard(
  ctx: WriteContext,
  input: {
    workstreamId: WorkstreamId;
    projectId: ProjectId;
    taskTitle: string;
    detail: WatchpointDetail | null;
    landing: HeldLanding | null;
  },
): void {
  const { detail, landing } = input;
  const looked = lookedAt(ctx.tx, input.workstreamId);
  const merged = mergeApproval(ctx.tx, input.workstreamId);
  const holding = new Map(
    (landing === null || detail === null ? [] : holdingHits(detail)).map((h) => [
      h.watchpoint.key,
      h,
    ]),
  );
  const hits = (detail?.hits ?? []).filter(
    (h) =>
      (h.watchpoint.loudness === WatchpointLoudness.Ask ||
        h.watchpoint.loudness === WatchpointLoudness.Hold) &&
      (holding.has(h.watchpoint.key) ? !merged(h) : !looked.has(h.watchpoint.key)),
  );
  if (hits.length === 0) {
    if (detail?.skipped === null) withdrawLiveCard(ctx, input.workstreamId);
    return;
  }
  const held = landing !== null && hits.some((h) => holding.has(h.watchpoint.key));
  const watchpoints = hits.map((h) => {
    const read = detail?.reads?.find((r) => r.key === h.watchpoint.key);
    const verdict = !holding.has(h.watchpoint.key)
      ? undefined
      : h.watchpoint.loudness === WatchpointLoudness.Hold
        ? WatchpointReadVerdict.Hold
        : read?.verdict;
    return {
      key: h.watchpoint.key,
      label: h.watchpoint.label,
      ...(verdict === undefined ? {} : { verdict }),
      ...(h.hash === undefined ? {} : { hash: h.hash }),
    };
  });
  const cardDetail = {
    watchpoints,
    ...(held ? { held: { batchId: landing.batchId, prUrl: landing.prUrl } } : {}),
  };
  const options = held
    ? [
        {
          label: WatchpointChoice.Merge,
          description: 'Let the pull request merge as the batch asked',
        },
        {
          label: WatchpointChoice.SendBack,
          description: 'Close the pull request and file a task with your note',
        },
      ]
    : [
        { label: WatchpointChoice.LooksRight, description: 'The changes are right as they are' },
        { label: WatchpointChoice.SendBack, description: 'Send it back with a note' },
      ];
  const body = lookBody(hits, held ? landing : null, {
    unreadable: held && hits.some((h) => holding.has(h.watchpoint.key) && h.hash === undefined),
    cantHold:
      landing === null && hits.some((h) => h.watchpoint.loudness === WatchpointLoudness.Hold),
  });
  const live = openItemsForWorkstream(ctx.tx, input.workstreamId).find(
    (item) => item.kind === InboxKind.Watchpoint && item.state === InboxState.Open,
  );
  if (live) {
    updateInboxItem(ctx, live.id, { body, options, detail: cardDetail });
    return;
  }
  insertInboxItem(ctx, {
    projectId: input.projectId,
    kind: InboxKind.Watchpoint,
    title: `Look at these changes: ${input.taskTitle}`,
    body,
    options,
    recommendation: null,
    category: 'product',
    urgency: 'normal',
    detail: cardDetail,
    foldKey: null,
    targets: [{ workstreamId: input.workstreamId, sessionId: null }],
  });
}

/** What a Look card says: what the change touched and, on a held card, what each answer does to the pull request. */
function lookBody(
  hits: readonly WatchpointHit[],
  landing: HeldLanding | null,
  says: { readonly unreadable: boolean; readonly cantHold: boolean },
): string {
  if (landing === null) {
    const touched = `The change touched ${labelsOf(hits)}, which you asked to look at yourself.`;
    return says.cantHold ? `${touched}\n\n${CANT_HOLD}` : touched;
  }
  const others =
    landing.alsoWaiting.length === 0
      ? ''
      : `\n\nAlso waiting in this pull request: ${landing.alsoWaiting.join(', ')}. Send Back closes it for them too.`;
  const parts = [
    `The change touched ${labelsOf(hits)}, which holds its pull request until you answer.`,
    landing.prUrl === null ? NO_PULL_REQUEST_YET : `Pull request: ${landing.prUrl}`,
    says.unreadable
      ? UNREADABLE_DIFF
      : 'Merge approves exactly the diff of these files you were shown and lets the pull request merge as the batch asked. A later change to them asks again. Send Back closes the pull request and files a task with your note.',
  ];
  return `${parts.join('\n\n')}${others}`;
}

/** What the shipper must do once the answer to a held card is committed; `rootId` names the pull request's root batch. */
export const WatchpointHoldAction = { Arm: 'arm', Close: 'close' } as const;
export type WatchpointHoldAction = (typeof WatchpointHoldAction)[keyof typeof WatchpointHoldAction];

export type WatchpointHoldEffect =
  | {
      readonly action: typeof WatchpointHoldAction.Arm;
      readonly rootId: BatchId;
      /** The pull request's URL when it is open; null before the ship opens it, which then arms it. */
      readonly prUrl: string | null;
    }
  | {
      readonly action: typeof WatchpointHoldAction.Close;
      readonly rootId: BatchId;
      readonly prUrl: string;
    };

/**
 * Acts on the answer to a Look card inside the write that closes it. Looks right records the builder's verdict as a
 * project decision, with the card as its source and their note as its rationale, so later briefs know the change was
 * looked at and why it was fine. Send back files one Ready follow-up task for the watchpoints the card named, holding
 * the builder's note. On a card that holds a pull request, Merge is the release itself (the answered card is what the
 * hold reads), and is refused for a diff 10db could not read in full; Send Back also names the pull request in the
 * task. What the shipper does once the write commits is returned: arm the pull request after Merge, close it after
 * Send Back.
 */
export function applyWatchpointAnswer(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: Pick<InboxAnswer, 'choice' | 'note'>,
): WatchpointHoldEffect | undefined {
  const target = item.targets[0];
  if (!target) return undefined;
  const detail = WatchpointCardDetail.safeParse(item.detail);
  const labels = detail.success ? detail.data.watchpoints.map((w) => w.label) : [];
  const held = detail.success ? detail.data.held : undefined;
  const taskId = getWorkstreamRow(ctx.tx, target.workstreamId).taskId;
  const note = (answer.note ?? '').trim();
  if (answer.choice === WatchpointChoice.Merge) {
    if (held === undefined || !detail.success) return undefined;
    const unreadable = detail.data.watchpoints.some(
      (w) => w.verdict !== undefined && holdsMerge(w.verdict) && w.hash === undefined,
    );
    if (unreadable) throw new InboxAnswerRefused(UNREADABLE_DIFF);
    return {
      action: WatchpointHoldAction.Arm,
      rootId: held.batchId,
      prUrl: getBatch(ctx.tx, held.batchId).prUrl,
    };
  }
  if (answer.choice === WatchpointChoice.SendBack) {
    const root = held === undefined ? null : getBatch(ctx.tx, held.batchId);
    const prUrl = root?.prUrl ?? null;
    insertWatchpointFollowUp(ctx, taskId, {
      watchpoints: labels,
      note,
      ...(root === null || prUrl === null
        ? {}
        : { pullRequest: { url: prUrl, branch: root.branch } }),
    });
    return root === null || prUrl === null
      ? undefined
      : { action: WatchpointHoldAction.Close, rootId: root.id, prUrl };
  }
  if (answer.choice !== WatchpointChoice.LooksRight) return undefined;
  // A task's title can be an agent's words, so the decision, which is the builder's, quotes it.
  const task = quotedWords(getTask(ctx.tx, taskId).title, 120);
  insertDecision(ctx, {
    projectId: item.projectId,
    scope: KnowledgeScope.Project,
    area: null,
    question:
      labels.length === 0
        ? `Did the changes in ${task} look right?`
        : `Did the changes to ${labels.join(', ')} in ${task} look right?`,
    choice: 'Looks right',
    rationale: note === '' ? 'Looked at in the Inbox' : note,
    decidedBy: BUILDER_HANDLE,
    sourceId: insertSource(ctx, SourceKind.InboxAnswer, { inboxId: item.id }),
  });
  return undefined;
}
