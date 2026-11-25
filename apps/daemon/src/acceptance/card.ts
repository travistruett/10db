import {
  AcceptanceChoice,
  AcceptanceDetail,
  AcceptanceVerdict,
  InboxKind,
  InboxState,
  type InboxAnswer,
  type InboxItemDto,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  answeredItemsForWorkstream,
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

function bodyOf(detail: AcceptanceDetail, reviewFollows: boolean): string {
  const open = detail.criteria
    .filter((c) => c.verdict !== AcceptanceVerdict.Met)
    .map((c) => `- ${c.criterion} (${c.note})`);
  return [
    `${reviewFollows ? 'The work went on to review' : 'The work shipped'}, and 10db could not confirm these criteria:`,
    ...open,
    ...(detail.unasked === null
      ? []
      : ['', `It may also do something the task didn't ask for: ${detail.unasked}`]),
    '',
    'Accept the work as it is, or send it back with a note.',
  ].join('\n');
}

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
  },
): InboxItemDto {
  const live = openItemsForWorkstream(ctx.tx, input.workstreamId).find(
    (item) => item.kind === InboxKind.Acceptance && item.state === InboxState.Open,
  );
  const body = bodyOf(input.detail, input.reviewFollows);
  const detail = { ...input.detail, [ACCEPTANCE_REVIEW_FOLLOWS_KEY]: input.reviewFollows };
  if (live) return updateInboxItem(ctx, live.id, { body, detail });
  return insertInboxItem(ctx, {
    projectId: input.projectId,
    kind: InboxKind.Acceptance,
    title: `Check these criteria: ${input.taskTitle}`,
    body,
    options: [
      { label: AcceptanceChoice.Accept, description: 'The work is right as it is' },
      { label: AcceptanceChoice.SendBack, description: 'Send it back with a note' },
    ],
    recommendation: null,
    category: 'product',
    urgency: 'normal',
    detail,
    foldKey: null,
    targets: [{ workstreamId: input.workstreamId, sessionId: null }],
  });
}

/** The criteria the builder accepted as they stood: those an answered acceptance card of the workstream listed as open. */
export function acceptedCriteria(db: DbReader, workstreamId: WorkstreamId): Set<string> {
  const accepted = new Set<string>();
  for (const card of answeredItemsForWorkstream(db, workstreamId, InboxKind.Acceptance)) {
    if (card.answer?.choice !== AcceptanceChoice.Accept) continue;
    const detail = AcceptanceDetail.safeParse(card.detail);
    if (!detail.success) continue;
    for (const c of detail.data.criteria)
      if (c.verdict !== AcceptanceVerdict.Met) accepted.add(c.criterion);
  }
  return accepted;
}

/**
 * Acts on the answer to an acceptance card inside the write that closes it. Accept changes nothing here:
 * `acceptedCriteria` reads the answered card from then on. Send back files one Ready follow-up task for the
 * criteria the card listed, with the builder's note, and leaves the original run as it is.
 */
export function applyAcceptanceAnswer(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: Pick<InboxAnswer, 'choice' | 'note'>,
): void {
  if (answer.choice !== AcceptanceChoice.SendBack) return;
  const target = item.targets[0];
  if (!target) return;
  const detail = AcceptanceDetail.safeParse(item.detail);
  const criteria = detail.success
    ? detail.data.criteria
        .filter((c) => c.verdict !== AcceptanceVerdict.Met)
        .map((c) => c.criterion)
    : [];
  const taskId = getWorkstreamRow(ctx.tx, target.workstreamId).taskId;
  insertAcceptanceFollowUp(ctx, taskId, { criteria, note: (answer.note ?? '').trim() });
}
