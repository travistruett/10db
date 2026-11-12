import {
  InboxKind,
  InboxState,
  RoutedBy,
  SendState,
  type InboxItemDto,
  type InboxItemId,
  type OutboundHit,
  type PersonDto,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  closeSend,
  draftSends,
  dropDraft,
  findPersonByHandle,
  getGoal,
  getInboxItem,
  getProject,
  getTask,
  insertDraft,
  listInbox,
  listPeople,
  listPendingTriage,
  ruleAssigneesOf,
  sendForCard,
  setInboxRecipients,
  targetTaskIds,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { Logger } from '../log';
import { composeSlackQuestion } from './compose';
import { scanOutbound } from './outbound-scan';
import { fallbackHandles } from './triage';

export interface DraftDeps {
  readonly projectName: string;
  /** The goal the card's task belongs to; the message names it, else the project. */
  readonly goalTitle: string | null;
  readonly builderName: string;
  /** Called after the write commits: sends at once when nothing holds the draft. */
  readonly afterDraft: (id: InboxItemId) => void;
  readonly log: Logger;
  /** The composer, replaceable only so a failure to compose can be exercised. */
  readonly compose?: typeof composeSlackQuestion;
}

const LIVE_SEND: readonly SendState[] = [SendState.Draft, SendState.Sending, SendState.Sent];

/** The people a card goes to, other than the builder, in routing order; null when one has no way to be reached. */
function recipientsOf(db: DbReader, card: InboxItemDto): PersonDto[] | null {
  const people: PersonDto[] = [];
  for (const handle of card.assignees) {
    if (handle === BUILDER_HANDLE) continue;
    const person = findPersonByHandle(db, handle);
    if (person?.isBuilder === true) continue;
    if (!person?.slack) return null;
    people.push(person);
  }
  return people;
}

/** The scan of the composed message and of the card's own words, so a fence dropped by composing still holds. */
function hitsFor(card: InboxItemDto, text: string): OutboundHit[] {
  const raw = [card.title, card.body, ...card.options.map((o) => `${o.label}\n${o.description}`)];
  const hits = scanOutbound(text);
  for (const hit of scanOutbound(raw.join('\n'))) {
    if (!hits.some((h) => h.pattern === hit.pattern)) hits.push(hit);
  }
  return hits;
}

/** What the message names: the project, the goal of the card's task, and the builder. */
export function draftContext(
  db: DbReader,
  card: InboxItemDto,
): Pick<DraftDeps, 'projectName' | 'goalTitle' | 'builderName'> {
  const [taskId] = targetTaskIds(db, card.targets);
  const task = taskId === undefined ? null : getTask(db, taskId);
  return {
    projectName: getProject(db, card.projectId).name,
    goalTitle: task?.goalId ? getGoal(db, task.goalId).title : null,
    builderName: listPeople(db).find((p) => p.isBuilder)?.name ?? 'The builder',
  };
}

/**
 * The message a question would be for these people, with what the scan holds, without writing anything:
 * Ask Someone… previews it for a person who is not on Slack too (Copy for them, spec §5).
 */
export function previewDraft(
  db: DbReader,
  card: InboxItemDto,
  people: readonly PersonDto[],
): { text: string; hits: OutboundHit[] } {
  const context = draftContext(db, card);
  const { text } = composeSlackQuestion({
    card,
    projectName: context.projectName,
    goalTitle: context.goalTitle,
    builderName: context.builderName,
    recipientNames: people.map((p) => p.name),
  });
  return { text, hits: hitsFor(card, text) };
}

/**
 * Writes a routed question's message as a draft, in the transaction that routed the card. A card for the
 * builder, a card waiting for triage, a card that already has a live send and any card but an open question
 * get none. A recipient with no Slack contact makes the card the builder's. A failure to compose or scan
 * leaves the card written without a draft, with the builder; the lane's question is never refused.
 * The result runs after the write commits.
 */
export function draftFor(
  ctx: WriteContext,
  card: InboxItemDto,
  deps: DraftDeps,
): (() => void) | null {
  if (card.kind !== InboxKind.Question || card.state !== InboxState.Open) return null;
  if (card.routedBy === RoutedBy.TriagePending) return null;
  if (sendForCard(ctx.tx, card.id) !== null && isLive(ctx, card.id)) return null;
  const recipients = recipientsOf(ctx.tx, card);
  if (recipients?.length === 0) return null;
  // A card the builder is left with: for want of a contact, it stays his; for want of a draft that a later
  // start can make, it keeps `rule`, so the sweep can tell it from one he took back on purpose.
  const toBuilder = (routedBy: RoutedBy): null => {
    setInboxRecipients(ctx, card.id, {
      assignees: [BUILDER_HANDLE],
      routedBy,
      suggestion: null,
    });
    return null;
  };
  if (recipients === null) return toBuilder(RoutedBy.Builder);
  let message: { text: string; hits: OutboundHit[] };
  try {
    const { text } = (deps.compose ?? composeSlackQuestion)({
      card,
      projectName: deps.projectName,
      goalTitle: deps.goalTitle,
      builderName: deps.builderName,
      recipientNames: recipients.map((p) => p.name),
    });
    message = { text, hits: hitsFor(card, text) };
  } catch (error) {
    deps.log.warn({ err: error, cardId: card.id }, 'could not draft a routed question');
    return toBuilder(RoutedBy.Rule);
  }
  insertDraft(ctx, {
    inboxItemId: card.id,
    recipients: recipients.map((p) => p.id),
    text: message.text,
    hits: message.hits,
  });
  return () => {
    deps.afterDraft(card.id);
  };
}

/**
 * `draftFor` for a card the caller has in hand, reading what the message names itself. A failure to read it
 * is logged and the card is left without a draft, so a lane's question is never refused for it.
 */
export function draftOnOpen(
  ctx: WriteContext,
  card: InboxItemDto,
  opts: { readonly afterDraft: (id: InboxItemId) => void; readonly log: Logger },
): (() => void) | null {
  let context: ReturnType<typeof draftContext>;
  try {
    context = draftContext(ctx.tx, card);
  } catch (error) {
    opts.log.warn({ err: error, cardId: card.id }, 'could not read what a drafted question names');
    return null;
  }
  return draftFor(ctx, card, { ...context, afterDraft: opts.afterDraft, log: opts.log });
}

function isLive(ctx: WriteContext, id: InboxItemId): boolean {
  const send = sendForCard(ctx.tx, id);
  return send !== null && LIVE_SEND.includes(send.state);
}

/**
 * A question left with the builder only because its draft could not be made (routed by rule, to the builder
 * alone, with no send) goes back to the people the rules gave it, so the sweep drafts it again.
 */
function retryable(ctx: WriteContext, card: InboxItemDto): InboxItemDto {
  if (
    card.kind !== InboxKind.Question ||
    card.routedBy !== RoutedBy.Rule ||
    !card.assignees.every((h) => h === BUILDER_HANDLE) ||
    sendForCard(ctx.tx, card.id) !== null
  )
    return card;
  const wanted = ruleAssigneesOf(ctx.tx, card.id);
  if (wanted.every((h) => h === BUILDER_HANDLE)) return card;
  return setInboxRecipients(ctx, card.id, {
    assignees: wanted,
    routedBy: RoutedBy.Rule,
    suggestion: null,
  });
}

/**
 * The start sweep: a card a crash left waiting for triage takes the lane's rule (or only leaves pending
 * when it is no longer open), a draft whose card closed is closed with it, one whose card was rerouted is
 * dropped, and a routed open question without a draft gets one. Answers the after-commit callbacks.
 */
export function sweepDrafts(
  ctx: WriteContext,
  opts: { readonly afterDraft: (id: InboxItemId) => void; readonly log: Logger },
): (() => void)[] {
  for (const card of listPendingTriage(ctx.tx)) {
    setInboxRecipients(ctx, card.id, {
      assignees: card.state === InboxState.Open ? fallbackHandles(ctx.tx, card) : card.assignees,
      routedBy: card.state === InboxState.Open ? RoutedBy.Rule : RoutedBy.Builder,
      suggestion: null,
    });
  }
  for (const draft of draftSends(ctx.tx)) {
    const card = getInboxItem(ctx.tx, draft.inboxItemId);
    if (card.state !== InboxState.Open) {
      closeSend(
        ctx,
        draft.id,
        card.state === InboxState.Answered || card.state === InboxState.Delivering
          ? 'builder'
          : 'cancelled',
      );
      continue;
    }
    const wanted = (recipientsOf(ctx.tx, card) ?? []).map((p) => p.id).sort();
    const send = sendForCard(ctx.tx, card.id);
    const have = (send?.people ?? [])
      .flatMap((p) => (p.recipient && p.personId !== null ? p.personId : []))
      .sort();
    if (wanted.join(',') !== have.join(',')) dropDraft(ctx, draft.id);
  }
  const after: (() => void)[] = [];
  for (const listed of listInbox(ctx.tx, { states: [InboxState.Open] })) {
    const card = retryable(ctx, listed);
    const done = draftFor(ctx, card, {
      ...draftContext(ctx.tx, card),
      afterDraft: opts.afterDraft,
      log: opts.log,
    });
    if (done) after.push(done);
  }
  return after;
}
