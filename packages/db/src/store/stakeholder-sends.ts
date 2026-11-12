import {
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  SendState,
  type InboxItemId,
  type OutboundHit,
  type PersonId,
  type StakeholderSendDto,
  type StakeholderSendId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

type SendRow = typeof schema.stakeholderSends.$inferSelect;
type HeldBy = NonNullable<SendRow['heldBy']>;

/** A person in a send's conversation. A recipient can answer; anyone else only talks. */
export interface SendPersonInput {
  readonly userId: string;
  readonly personId: PersonId | null;
  readonly name: string;
  readonly recipient: boolean;
}

export interface OpenSendRow {
  readonly id: StakeholderSendId;
  readonly inboxItemId: InboxItemId;
  readonly people: readonly SendPersonInput[];
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly lastReadTs: string;
  readonly movedFrom: { channelId: string; threadTs: string; lastReadTs: string | null } | null;
  readonly sentAt: string;
  readonly waitStartedAt: string;
  readonly remindedAt: string | null;
  readonly returnedAt: string | null;
  readonly proposal: { choice: string; confidence: number; ts: string | null } | null;
  readonly settledThroughTs: string | null;
  readonly askedWhichWayAt: string | null;
  readonly askedWhichWayTs: string | null;
  readonly approvalSeenAt: string | null;
  readonly approvalBy: PersonId | null;
  readonly loneReplyPendingSince: string | null;
}

function peopleOf(db: DbReader, sendId: StakeholderSendId): SendPersonInput[] {
  return db
    .select()
    .from(schema.stakeholderSendPeople)
    .where(eq(schema.stakeholderSendPeople.sendId, sendId))
    .orderBy(asc(schema.stakeholderSendPeople.position))
    .all()
    .map((p) => ({
      userId: p.userId,
      personId: p.personId,
      name: p.name,
      recipient: p.recipient,
    }));
}

function toDto(db: DbReader, row: SendRow): StakeholderSendDto {
  return {
    id: row.id,
    inboxItemId: row.inboxItemId,
    state: row.state,
    people: peopleOf(db, row.id),
    text: row.text,
    hits: row.hits,
    permalink: row.permalink,
    sentAt: row.sentAt,
    remindedAt: row.remindedAt,
    answeredAt: row.answeredAt,
    returnedAt: row.returnedAt,
    returnedReason: row.returnedReason,
    heldBy: row.heldBy,
    proposal: row.proposal && { choice: row.proposal.choice, confidence: row.proposal.confidence },
    askedWhichWay: row.askedWhichWayAt !== null,
    conversation: [],
    reply: row.reply,
    replyVia: row.replyVia,
    readAs: row.readAs,
    answeredBy: row.answeredBy,
    error: row.error,
  };
}

function getRow(db: DbReader, id: StakeholderSendId): SendRow {
  const row = db
    .select()
    .from(schema.stakeholderSends)
    .where(eq(schema.stakeholderSends.id, id))
    .get();
  if (!row) throw new NotFoundError('stakeholder send', id);
  return row;
}

/** Reads the row, refuses a move from any state not in `from`, and answers the row it checked. */
function guarded(
  ctx: WriteContext,
  id: StakeholderSendId,
  move: string,
  from: readonly SendState[],
): SendRow {
  const row = getRow(ctx.tx, id);
  if (!from.includes(row.state))
    throw new ConflictError(`A send that is ${row.state} cannot ${move}`);
  return row;
}

function change(
  ctx: WriteContext,
  row: SendRow,
  set: Partial<typeof schema.stakeholderSends.$inferInsert>,
): void {
  ctx.tx
    .update(schema.stakeholderSends)
    .set({ ...set, updatedAt: ctx.now })
    .where(eq(schema.stakeholderSends.id, row.id))
    .run();
  ctx.emit({
    type: EventType.StakeholderSendChanged,
    entityType: 'stakeholder_send',
    entityId: row.id,
    data: { inboxItemId: row.inboxItemId, state: set.state ?? row.state },
  });
}

/** The draft for a card, one recipient row each; a card has at most one send. */
export function insertDraft(
  ctx: WriteContext,
  input: {
    readonly inboxItemId: InboxItemId;
    readonly recipients: readonly PersonId[];
    readonly text: string;
    readonly hits: readonly OutboundHit[];
  },
): StakeholderSendDto {
  const contacts = input.recipients.map((personId) => {
    const row = ctx.tx
      .select({
        userId: schema.personContacts.userId,
        name: schema.people.name,
      })
      .from(schema.personContacts)
      .innerJoin(schema.people, eq(schema.people.id, schema.personContacts.personId))
      .where(eq(schema.personContacts.personId, personId))
      .get();
    if (!row) throw new InvalidError(`${personId} has no Slack contact`);
    return { personId, ...row };
  });
  const id = mintId('StakeholderSend');
  ctx.tx
    .insert(schema.stakeholderSends)
    .values({
      id,
      inboxItemId: input.inboxItemId,
      state: SendState.Draft,
      text: input.text,
      hits: [...input.hits],
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .run();
  contacts.forEach((c, position) => {
    ctx.tx
      .insert(schema.stakeholderSendPeople)
      .values({
        sendId: id,
        userId: c.userId,
        personId: c.personId,
        name: c.name,
        recipient: true,
        position,
      })
      .run();
  });
  const row = getRow(ctx.tx, id);
  ctx.emit({
    type: EventType.StakeholderSendChanged,
    entityType: 'stakeholder_send',
    entityId: id,
    data: { inboxItemId: input.inboxItemId, state: row.state },
  });
  return toDto(ctx.tx, row);
}

export function updateDraft(
  ctx: WriteContext,
  id: StakeholderSendId,
  edit: { readonly text: string; readonly hits: readonly OutboundHit[] },
): void {
  const row = guarded(ctx, id, 'be edited', [SendState.Draft]);
  change(ctx, row, { text: edit.text, hits: [...edit.hits] });
}

export function setHeldBy(ctx: WriteContext, id: StakeholderSendId, heldBy: HeldBy | null): void {
  const row = guarded(ctx, id, 'be held', [SendState.Draft]);
  change(ctx, row, { heldBy });
}

/** The post is about to be made. A hold released by the builder makes the thread a reviewed one. */
export function markSending(
  ctx: WriteContext,
  id: StakeholderSendId,
  input: {
    readonly textSha256: string;
    readonly threadTs: string | null;
    readonly startedAt: string;
  },
): void {
  const row = guarded(ctx, id, 'start sending', [SendState.Draft]);
  change(ctx, row, {
    state: SendState.Sending,
    textSha256: input.textSha256,
    threadTs: input.threadTs,
    startedAt: input.startedAt,
    newThread: input.threadTs === null,
    reviewed: row.heldBy !== null,
    heldBy: null,
  });
}

export function markSent(
  ctx: WriteContext,
  id: StakeholderSendId,
  input: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly messageTs: string;
    readonly permalink: string | null;
    readonly at: string;
  },
): void {
  const row = guarded(ctx, id, 'be marked sent', [SendState.Sending]);
  change(ctx, row, {
    state: SendState.Sent,
    channelId: input.channelId,
    threadTs: input.threadTs,
    messageTs: input.messageTs,
    permalink: input.permalink,
    sentAt: input.at,
    lastReadTs: input.messageTs,
    waitStartedAt: input.at,
  });
}

export function markSettled(ctx: WriteContext, id: StakeholderSendId, throughTs: string): void {
  const row = guarded(ctx, id, 'settle', [SendState.Sent]);
  change(ctx, row, { settledThroughTs: throughTs });
}

export function markAskedWhichWay(
  ctx: WriteContext,
  id: StakeholderSendId,
  input: { readonly at: string; readonly ts: string; readonly throughTs: string },
): void {
  const row = guarded(ctx, id, 'ask which way', [SendState.Sent]);
  change(ctx, row, {
    askedWhichWayAt: input.at,
    askedWhichWayTs: input.ts,
    settledThroughTs: input.throughTs,
  });
}

export function markApprovalSeen(
  ctx: WriteContext,
  id: StakeholderSendId,
  seen: { readonly at: string; readonly by: PersonId } | null,
): void {
  const row = guarded(ctx, id, 'see an approval', [SendState.Sent]);
  change(ctx, row, { approvalSeenAt: seen?.at ?? null, approvalBy: seen?.by ?? null });
}

export function markLoneReplyPending(
  ctx: WriteContext,
  id: StakeholderSendId,
  at: string | null,
): void {
  const row = guarded(ctx, id, 'hold a lone reply', [SendState.Sent]);
  change(ctx, row, { loneReplyPendingSince: at });
}

function addPeople(
  ctx: WriteContext,
  id: StakeholderSendId,
  added: readonly SendPersonInput[],
): void {
  const have = new Set(peopleOf(ctx.tx, id).map((p) => p.userId));
  let position = have.size;
  for (const person of added) {
    if (have.has(person.userId)) continue;
    have.add(person.userId);
    ctx.tx
      .insert(schema.stakeholderSendPeople)
      .values({ sendId: id, ...person, position: position++ })
      .run();
  }
}

export function addPeopleToSend(
  ctx: WriteContext,
  id: StakeholderSendId,
  added: readonly SendPersonInput[],
): void {
  const row = guarded(ctx, id, 'take more people', [SendState.Sent]);
  addPeople(ctx, id, added);
  change(ctx, row, {});
}

/** The question reposted in a group DM; the old thread is kept so a reply there still counts. */
export function moveSend(
  ctx: WriteContext,
  id: StakeholderSendId,
  input: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly messageTs: string;
    readonly permalink: string | null;
    readonly added: readonly SendPersonInput[];
  },
): void {
  const row = guarded(ctx, id, 'move', [SendState.Sent]);
  addPeople(ctx, id, input.added);
  change(ctx, row, {
    movedFrom:
      row.channelId !== null && row.threadTs !== null
        ? { channelId: row.channelId, threadTs: row.threadTs, lastReadTs: row.lastReadTs }
        : null,
    channelId: input.channelId,
    threadTs: input.threadTs,
    messageTs: input.messageTs,
    permalink: input.permalink,
    lastReadTs: input.messageTs,
  });
}

export function markReminded(ctx: WriteContext, id: StakeholderSendId, at: string): void {
  const row = guarded(ctx, id, 'be reminded', [SendState.Sent]);
  change(ctx, row, { remindedAt: at });
}

export function setProposal(
  ctx: WriteContext,
  id: StakeholderSendId,
  proposal: {
    readonly choice: string;
    readonly confidence: number;
    readonly ts: string | null;
  } | null,
): void {
  const row = guarded(ctx, id, 'take a proposal', [SendState.Sent]);
  change(ctx, row, { proposal });
}

export function markAnswered(
  ctx: WriteContext,
  id: StakeholderSendId,
  input: {
    readonly reply: { readonly text: string; readonly userId: string; readonly ts: string };
    readonly readAs: 'option' | 'own_words' | 'approved';
    readonly answeredBy: PersonId | null;
    readonly replyVia: 'thread' | 'top_level';
  },
): void {
  const row = guarded(ctx, id, 'be answered', [SendState.Sent]);
  change(ctx, row, {
    state: SendState.Answered,
    reply: { ...input.reply },
    readAs: input.readAs,
    answeredBy: input.answeredBy,
    replyVia: input.replyVia,
    answeredAt: ctx.now,
  });
}

export function closeSend(
  ctx: WriteContext,
  id: StakeholderSendId,
  reason: 'builder' | 'taken_back' | 'cancelled',
): void {
  const row = guarded(ctx, id, 'close', [SendState.Draft, SendState.Sending, SendState.Sent]);
  change(ctx, row, { state: SendState.Closed, closedReason: reason });
}

export function failSend(ctx: WriteContext, id: StakeholderSendId, error: string): void {
  const row = guarded(ctx, id, 'fail', [SendState.Sending, SendState.Sent]);
  change(ctx, row, { state: SendState.Failed, error });
}

export function markReturned(
  ctx: WriteContext,
  id: StakeholderSendId,
  reason: 'timer' | 'disagreed',
): void {
  const row = guarded(ctx, id, 'be returned', [SendState.Sent]);
  change(ctx, row, { returnedAt: ctx.now, returnedReason: reason });
}

/** The builder keeps waiting: both timers restart from `at`. */
export function keepWaiting(ctx: WriteContext, id: StakeholderSendId, at: string): void {
  const row = guarded(ctx, id, 'keep waiting', [SendState.Sent]);
  change(ctx, row, {
    returnedAt: null,
    returnedReason: null,
    remindedAt: null,
    waitStartedAt: at,
  });
}

export function dropDraft(ctx: WriteContext, id: StakeholderSendId): void {
  const row = guarded(ctx, id, 'be dropped', [SendState.Draft]);
  ctx.tx
    .delete(schema.stakeholderSendPeople)
    .where(eq(schema.stakeholderSendPeople.sendId, id))
    .run();
  ctx.tx.delete(schema.stakeholderSends).where(eq(schema.stakeholderSends.id, id)).run();
  ctx.emit({
    type: EventType.StakeholderSendChanged,
    entityType: 'stakeholder_send',
    entityId: id,
    data: { inboxItemId: row.inboxItemId, state: 'dropped' },
  });
}

export function sendForCard(db: DbReader, inboxItemId: InboxItemId): StakeholderSendDto | null {
  const row = db
    .select()
    .from(schema.stakeholderSends)
    .where(eq(schema.stakeholderSends.inboxItemId, inboxItemId))
    .get();
  return row ? toDto(db, row) : null;
}

function toOpen(db: DbReader, row: SendRow): OpenSendRow | null {
  const { channelId, threadTs, messageTs, lastReadTs, sentAt, waitStartedAt } = row;
  if (
    channelId === null ||
    threadTs === null ||
    messageTs === null ||
    lastReadTs === null ||
    sentAt === null ||
    waitStartedAt === null
  )
    return null;
  return {
    id: row.id,
    inboxItemId: row.inboxItemId,
    people: peopleOf(db, row.id),
    channelId,
    threadTs,
    messageTs,
    lastReadTs,
    movedFrom: row.movedFrom,
    sentAt,
    waitStartedAt,
    remindedAt: row.remindedAt,
    returnedAt: row.returnedAt,
    proposal: row.proposal,
    settledThroughTs: row.settledThroughTs,
    askedWhichWayAt: row.askedWhichWayAt,
    askedWhichWayTs: row.askedWhichWayTs,
    approvalSeenAt: row.approvalSeenAt,
    approvalBy: row.approvalBy,
    loneReplyPendingSince: row.loneReplyPendingSince,
  };
}

/** Every send waiting for an answer, oldest first. */
export function openSends(db: DbReader): OpenSendRow[] {
  return db
    .select()
    .from(schema.stakeholderSends)
    .where(eq(schema.stakeholderSends.state, SendState.Sent))
    .orderBy(asc(schema.stakeholderSends.sentAt), asc(schema.stakeholderSends.id))
    .all()
    .flatMap((row) => toOpen(db, row) ?? []);
}

/** Open sends in a channel's thread, whether it is their current thread or the one they moved from. */
export function sendsInThread(db: DbReader, channelId: string, threadTs: string): OpenSendRow[] {
  return openSends(db).filter(
    (s) =>
      (s.channelId === channelId && s.threadTs === threadTs) ||
      (s.movedFrom?.channelId === channelId && s.movedFrom.threadTs === threadTs),
  );
}

/** Sends whose post was started and not finished, for the recovery pass. */
export function sendingSends(
  db: DbReader,
): { id: StakeholderSendId; threadTs: string | null; startedAt: string }[] {
  return db
    .select()
    .from(schema.stakeholderSends)
    .where(eq(schema.stakeholderSends.state, SendState.Sending))
    .all()
    .flatMap((r) =>
      r.startedAt === null ? [] : [{ id: r.id, threadTs: r.threadTs, startedAt: r.startedAt }],
    );
}

/**
 * The thread a question for these people on this task joins: the newest thread whose recipients are
 * exactly these people and whose card was asked by a run of the task. `reviewed` says the builder
 * released a hold in it, so a follow-up skips review.
 */
export function latestThreadFor(
  db: DbReader,
  recipients: readonly PersonId[],
  taskId: TaskId,
): { channelId: string; threadTs: string; reviewed: boolean } | null {
  const wanted = [...recipients].sort().join(',');
  const rows = db
    .select({ send: schema.stakeholderSends, targets: schema.inboxItems.targets })
    .from(schema.stakeholderSends)
    .innerJoin(schema.inboxItems, eq(schema.inboxItems.id, schema.stakeholderSends.inboxItemId))
    .where(
      and(
        inArray(schema.stakeholderSends.state, [SendState.Sent, SendState.Answered]),
        isNotNull(schema.stakeholderSends.threadTs),
      ),
    )
    .orderBy(desc(schema.stakeholderSends.sentAt), desc(schema.stakeholderSends.id))
    .all();
  const threads = new Map<string, boolean>();
  for (const { send, targets } of rows) {
    if (send.channelId === null || send.threadTs === null) continue;
    const onTask = targets.some((t) => taskOf(db, t.workstreamId) === taskId);
    if (!onTask) continue;
    const people = peopleOf(db, send.id)
      .filter((p) => p.recipient)
      .flatMap((p) => p.personId ?? [])
      .sort()
      .join(',');
    if (people !== wanted) continue;
    const key = `${send.channelId}\u0000${send.threadTs}`;
    threads.set(key, (threads.get(key) ?? false) || send.reviewed);
  }
  const first = rows.find(({ send }) =>
    threads.has(`${send.channelId ?? ''}\u0000${send.threadTs ?? ''}`),
  );
  if (!first?.send.channelId || !first.send.threadTs) return null;
  const reviewed = threads.get(`${first.send.channelId}\u0000${first.send.threadTs}`) ?? false;
  return { channelId: first.send.channelId, threadTs: first.send.threadTs, reviewed };
}

function taskOf(db: DbReader, workstreamId: WorkstreamId): TaskId | undefined {
  return db
    .select({ taskId: schema.workstreams.taskId })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.id, workstreamId))
    .get()?.taskId;
}

/** New threads sent to a person since `since`; a failed send, a follow-up, a move or a reminder is never one. */
export function newThreadsSince(db: DbReader, personId: PersonId, since: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.stakeholderSends)
    .innerJoin(
      schema.stakeholderSendPeople,
      eq(schema.stakeholderSendPeople.sendId, schema.stakeholderSends.id),
    )
    .where(
      and(
        eq(schema.stakeholderSendPeople.personId, personId),
        eq(schema.stakeholderSends.newThread, true),
        isNotNull(schema.stakeholderSends.sentAt),
        gte(schema.stakeholderSends.sentAt, since),
        ne(schema.stakeholderSends.state, SendState.Failed),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/** Whether anything was ever sent to this person; the first send is always reviewed. */
export function everSent(db: DbReader, personId: PersonId): boolean {
  const row = db
    .select({ id: schema.stakeholderSends.id })
    .from(schema.stakeholderSends)
    .innerJoin(
      schema.stakeholderSendPeople,
      eq(schema.stakeholderSendPeople.sendId, schema.stakeholderSends.id),
    )
    .where(
      and(
        eq(schema.stakeholderSendPeople.personId, personId),
        isNotNull(schema.stakeholderSends.sentAt),
      ),
    )
    .get();
  return row !== undefined;
}
