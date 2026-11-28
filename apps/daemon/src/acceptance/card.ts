import { coverageSection } from '../evals';
import { proofNeedsHands } from './hands';
import { unaskedDescription, unprovenResults } from './read';
import {
  AcceptanceChoice,
  AcceptanceDetail,
  AcceptanceVerdict,
  Answerer,
  InboxKind,
  InboxState,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  answeredItemsForWorkstream,
  dropTaskCriteria,
  getWorkstreamRow,
  insertAcceptanceFollowUp,
  insertInboxItem,
  openItemsForWorkstream,
  updateInboxItem,
  type DbReader,
  type WriteContext,
} from '@10db/db';

/** The detail key naming whether a Review follows the run, so the card says where the work went. */
const ACCEPTANCE_REVIEW_FOLLOWS_KEY = 'reviewFollows';

/**
 * Whose hands the proof is in: `hands` when every unproven criterion is one only the builder can prove, so the card
 * says exactly what to do; `budget` when 10db sent the work back for proof as often as the fix budget allows and
 * the criteria are still unproven.
 */
const AcceptanceCardKind = { Hands: 'hands', Budget: 'budget' } as const;
type AcceptanceCardKind = (typeof AcceptanceCardKind)[keyof typeof AcceptanceCardKind];

function cardKindOf(detail: AcceptanceDetail, reviewFollows: boolean): AcceptanceCardKind {
  const unproven = unprovenResults(detail.criteria, reviewFollows);
  return unproven.length > 0 && unproven.every((c) => proofNeedsHands(c.criterion) !== null)
    ? AcceptanceCardKind.Hands
    : AcceptanceCardKind.Budget;
}

function bodyOf(
  detail: AcceptanceDetail,
  reviewFollows: boolean,
  evalLines: readonly string[],
  kind: AcceptanceCardKind,
): string {
  const unasked = unaskedDescription(detail.unasked);
  const where = reviewFollows ? 'The work went on to review' : 'The work shipped';
  const open = detail.criteria.filter((c) => c.verdict !== AcceptanceVerdict.Met);
  const extra = [
    ...(unasked === null
      ? []
      : ['', `It may also do something the task didn't ask for: ${unasked}`]),
    ...coverageSection(evalLines),
  ];
  if (kind === AcceptanceCardKind.Hands)
    return [
      `${where}. Only you can prove ${open.length === 1 ? 'this criterion' : 'these criteria'}:`,
      ...open.map((c) => `- ${proofNeedsHands(c.criterion) ?? `${c.criterion} (${c.note})`}`),
      ...extra,
      '',
      'Accept it once it holds, send it back with what you saw, or drop the criterion.',
    ].join('\n');
  return [
    `${where}. 10db sent it back for proof as often as its fix budget allows and could not prove ${open.length === 1 ? 'this criterion' : 'these criteria'}:`,
    ...open.map((c) => `- ${c.criterion} (${c.note})`),
    ...extra,
    '',
    'Accept without proof of it, drop it from the task, or send the work back with a note.',
  ].join('\n');
}

const OPTIONS: readonly InboxOption[] = [
  {
    label: AcceptanceChoice.Accept,
    description: 'Accept the criteria without proof: the work stays as it is',
  },
  {
    label: AcceptanceChoice.Drop,
    description: 'Take the criteria off the task, so nothing asks for their proof again',
  },
  {
    label: AcceptanceChoice.SendBack,
    description: 'Send it back with a note: files a follow-up task',
  },
];

/**
 * Tells the builder which criteria the acceptance check could not settle on a run that went on. A workstream has
 * one live acceptance card: a second pass updates it. The run never waits on it.
 */
export function raiseAcceptanceCard(
  ctx: WriteContext,
  input: {
    workstreamId: WorkstreamId;
    projectId: ProjectId;
    taskTitle: string;
    detail: AcceptanceDetail;
    reviewFollows: boolean;
    /** What the eval suites the change touched have to say; the card is never raised for them alone. */
    evalLines: readonly string[];
  },
): InboxItemDto {
  const live = openItemsForWorkstream(ctx.tx, input.workstreamId).find(
    (item) => item.kind === InboxKind.Acceptance && item.state === InboxState.Open,
  );
  const kind = cardKindOf(input.detail, input.reviewFollows);
  const body = bodyOf(input.detail, input.reviewFollows, input.evalLines, kind);
  const title =
    kind === AcceptanceCardKind.Hands
      ? `Needs your hands: ${input.taskTitle}`
      : `Accept without proof, or drop: ${input.taskTitle}`;
  const detail = { ...input.detail, [ACCEPTANCE_REVIEW_FOLLOWS_KEY]: input.reviewFollows };
  if (live) return updateInboxItem(ctx, live.id, { title, body, options: OPTIONS, detail });
  return insertInboxItem(ctx, {
    projectId: input.projectId,
    kind: InboxKind.Acceptance,
    title,
    body,
    options: [...OPTIONS],
    // Never Accept: a rule that recommended accepting unproven work would lower the builder's bar.
    recommendation: null,
    category: 'product',
    urgency: 'normal',
    detail,
    foldKey: null,
    targets: [{ workstreamId: input.workstreamId, sessionId: null }],
  });
}

/**
 * The criteria the builder accepted without proof, as they stood: those an answered acceptance card of the workstream
 * listed as open. Only the builder's own answer counts; an answer an agent or a rule gave accepts nothing. One stored
 * before answers named who gave them has no answerer and counts, since the builder was the only one who could answer then.
 */
export function acceptedCriteria(db: DbReader, workstreamId: WorkstreamId): Set<string> {
  const accepted = new Set<string>();
  for (const card of answeredItemsForWorkstream(db, workstreamId, InboxKind.Acceptance)) {
    if (card.answer?.choice !== AcceptanceChoice.Accept) continue;
    if (card.answer.answerer !== undefined && card.answer.answerer !== Answerer.Builder) continue;
    const detail = AcceptanceDetail.safeParse(card.detail);
    if (!detail.success) continue;
    for (const c of detail.data.criteria)
      if (c.verdict !== AcceptanceVerdict.Met) accepted.add(c.criterion);
  }
  return accepted;
}

/**
 * Acts on the answer to an acceptance card inside the write that closes it. Accept changes nothing here:
 * `acceptedCriteria` reads the answered card from then on. Drop takes the criteria the card listed off the task.
 * Send back files one Ready follow-up task for them, with the builder's note, and leaves the original run as it is.
 */
export function applyAcceptanceAnswer(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: Pick<InboxAnswer, 'choice' | 'note'>,
): void {
  if (answer.choice !== AcceptanceChoice.SendBack && answer.choice !== AcceptanceChoice.Drop)
    return;
  const target = item.targets[0];
  if (!target) return;
  const detail = AcceptanceDetail.safeParse(item.detail);
  const criteria = detail.success
    ? detail.data.criteria
        .filter((c) => c.verdict !== AcceptanceVerdict.Met)
        .map((c) => c.criterion)
    : [];
  const taskId = getWorkstreamRow(ctx.tx, target.workstreamId).taskId;
  if (answer.choice === AcceptanceChoice.Drop) dropTaskCriteria(ctx, taskId, criteria);
  else insertAcceptanceFollowUp(ctx, taskId, { criteria, note: (answer.note ?? '').trim() });
}
