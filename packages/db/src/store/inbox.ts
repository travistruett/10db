import {
  EventType,
  InboxState,
  mintId,
  NotFoundError,
  PARK_TASK_CHOICE,
  type RecordedAnswer,
  type InboxItemDto,
  type InboxItemId,
  type InboxKind,
  type InboxOption,
  type InboxTarget,
  type PersonId,
  type ProjectId,
  type ProposalId,
  type QuestionCategory,
  type TaskId,
  type Urgency,
  type WorkstreamId,
  RoutedBy,
} from '@10db/contracts';
import { and, asc, desc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema';
import type { Json } from '../json';
import { assigneesFor } from './routing-rules';
import { sendForCard } from './stakeholder-sends';
import type { DbReader, WriteContext } from './store';
import { BUILDER_HANDLE } from './team';

export interface NewInboxItem {
  readonly projectId: ProjectId;
  readonly kind: InboxKind;
  readonly title: string;
  readonly body: string;
  readonly options: readonly InboxOption[];
  readonly recommendation: string | null;
  readonly category: QuestionCategory;
  readonly urgency: Urgency;
  readonly detail: Record<string, Json> | null;
  readonly foldKey: string | null;
  readonly targets: readonly InboxTarget[];
  /** The topic the lane named, which a project's topic routes can match. */
  readonly topic?: string | null;
  /** The card is a Workbench pass page's question, which the builder answers. */
  readonly passPage?: boolean;
  /**
   * Leave a triage-tier card with the builder until the judge routes it: the rules' recipients are kept
   * for folding, and `routedBy` is `triage_pending`.
   */
  readonly pendingTriage?: boolean;
}

/** The detail key marking a card whose message could not be composed; any recipients set by hand clear it. */
export const DRAFT_FAILED_KEY = 'draftFailed';
/** The detail key holding why a tie went to the builder. */
export const ROUTE_NOTE_KEY = 'routeNote';
/** The detail key holding the topic the lane named. */
export const ASKED_TOPIC_KEY = 'askedTopic';

const LIVE_STATES: InboxState[] = [InboxState.Open, InboxState.Answered, InboxState.Delivering];

/** Every column except `foldKey` and `ruleAssignees`, which stay internal to routing and folding. */
function toDto(db: DbReader, row: typeof schema.inboxItems.$inferSelect): InboxItemDto {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    state: row.state,
    title: row.title,
    body: row.body,
    options: row.options,
    recommendation: row.recommendation,
    category: row.category,
    urgency: row.urgency,
    assignee: row.assignee,
    assignees: row.assignees.length > 0 ? row.assignees : [row.assignee],
    routedBy: row.routedBy,
    routeSuggestion: row.routeSuggestion,
    send: sendForCard(db, row.id),
    detail: row.detail,
    answer: row.answer,
    targets: row.targets,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The tasks the targeted workstreams run, so a routing rule can match by task, goal and area. */
export function targetTaskIds(db: DbReader, targets: readonly InboxTarget[]): TaskId[] {
  const ids = new Set<TaskId>();
  for (const target of targets) {
    const row = db
      .select({ taskId: schema.workstreams.taskId })
      .from(schema.workstreams)
      .where(eq(schema.workstreams.id, target.workstreamId))
      .get();
    if (row) ids.add(row.taskId);
  }
  return [...ids];
}

/** The lane's topic and a too-big tie's note ride in the card's detail, where triage and the card read them. */
function withRouting(
  detail: Record<string, Json> | null,
  note: string | null,
  topic: string | null,
): Record<string, Json> | null {
  if (note === null && topic === null) return detail;
  return {
    ...detail,
    ...(note === null ? {} : { [ROUTE_NOTE_KEY]: note }),
    ...(topic === null ? {} : { [ASKED_TOPIC_KEY]: topic }),
  };
}

export function insertInboxItem(ctx: WriteContext, newItem: NewInboxItem): InboxItemDto {
  const { topic, passPage, pendingTriage, ...item } = newItem;
  const routed = assigneesFor(ctx.tx, {
    projectId: item.projectId,
    kind: item.kind,
    category: item.category,
    topic: topic ?? null,
    taskIds: targetTaskIds(ctx.tx, item.targets),
    passPage: passPage ?? false,
  });
  const pending = pendingTriage === true && routed.tier === 'triage';
  const shown = pending ? [BUILDER_HANDLE] : routed.handles;
  const recipients = {
    assignee: shown[0] ?? BUILDER_HANDLE,
    assignees: shown,
    ruleAssignees: routed.handles,
    routedBy: pending ? RoutedBy.TriagePending : RoutedBy.Rule,
    routeSuggestion: null,
  };
  const row = {
    id: mintId('InboxItem'),
    ...item,
    // A tie too big for a group DM is explained on the card.
    detail: withRouting(item.detail, routed.note, topic ?? null),
    options: [...item.options],
    targets: [...item.targets],
    state: InboxState.Open,
    ...recipients,
    answer: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.inboxItems).values(row).run();
  ctx.emit({
    type: EventType.InboxOpened,
    entityType: 'inbox',
    entityId: row.id,
    data: { kind: item.kind, projectId: item.projectId },
  });
  return toDto(ctx.tx, row);
}

export function getInboxItem(db: DbReader, id: InboxItemId): InboxItemDto {
  const row = db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id)).get();
  if (!row) throw new NotFoundError('inbox item', id);
  return toDto(db, row);
}

const URGENCY_ORDER = sql`CASE ${schema.inboxItems.urgency} WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END`;

/**
 * The inbox, most urgent and then oldest first. With `recent`, only that many items instead, the most
 * recently updated first: for lists that only grow, such as the resolved cards.
 */
export function listInbox(
  db: DbReader,
  filter: { states?: readonly InboxState[]; projectId?: ProjectId; recent?: number } = {},
): InboxItemDto[] {
  const where: SQL[] = [];
  if (filter.states) where.push(inArray(schema.inboxItems.state, [...filter.states]));
  if (filter.projectId) where.push(eq(schema.inboxItems.projectId, filter.projectId));
  const query = db
    .select()
    .from(schema.inboxItems)
    .where(and(...where));
  const rows =
    filter.recent === undefined
      ? query
          .orderBy(URGENCY_ORDER, asc(schema.inboxItems.createdAt), asc(schema.inboxItems.id))
          .all()
      : query
          .orderBy(desc(schema.inboxItems.updatedAt), desc(schema.inboxItems.id))
          .limit(filter.recent)
          .all();
  return rows.map((row) => toDto(db, row));
}

/** Every card still marked as waiting for triage, in any state: the start sweep settles them. */
export function listPendingTriage(db: DbReader): InboxItemDto[] {
  return db
    .select()
    .from(schema.inboxItems)
    .where(eq(schema.inboxItems.routedBy, RoutedBy.TriagePending))
    .orderBy(asc(schema.inboxItems.createdAt), asc(schema.inboxItems.id))
    .all()
    .map((row) => toDto(db, row));
}

export function findOpenByFoldKey(
  db: DbReader,
  projectId: ProjectId,
  foldKey: string,
): InboxItemDto | undefined {
  const row = db
    .select()
    .from(schema.inboxItems)
    .where(
      and(
        eq(schema.inboxItems.projectId, projectId),
        eq(schema.inboxItems.foldKey, foldKey),
        eq(schema.inboxItems.state, InboxState.Open),
      ),
    )
    .get();
  return row ? toDto(db, row) : undefined;
}

/** The open card that asks the builder about a proposal, if it is still open. */
export function findOpenProposalCard(
  db: DbReader,
  proposalId: ProposalId,
): InboxItemDto | undefined {
  const row = db
    .select()
    .from(schema.inboxItems)
    .where(
      and(
        eq(schema.inboxItems.kind, 'proposal'),
        eq(schema.inboxItems.state, InboxState.Open),
        sql`json_extract(${schema.inboxItems.detail}, '$.proposalId') = ${proposalId}`,
      ),
    )
    .get();
  return row ? toDto(db, row) : undefined;
}

/** The states of a card the builder answered, whether or not the answer has been delivered. */
const ANSWERED_STATES: InboxState[] = [
  InboxState.Answered,
  InboxState.Delivering,
  InboxState.Resolved,
];

/**
 * Whether the builder ever answered a card of the project with this fold key. A card that is still
 * open, or that was withdrawn or expired unanswered, doesn't count.
 */
export function hasAnsweredByFoldKey(db: DbReader, projectId: ProjectId, foldKey: string): boolean {
  const row = db
    .select({ id: schema.inboxItems.id })
    .from(schema.inboxItems)
    .where(
      and(
        eq(schema.inboxItems.projectId, projectId),
        eq(schema.inboxItems.foldKey, foldKey),
        inArray(schema.inboxItems.state, ANSWERED_STATES),
      ),
    )
    .get();
  return row !== undefined;
}

export function updateInboxItem(
  ctx: WriteContext,
  id: InboxItemId,
  patch: {
    readonly state?: InboxState;
    readonly title?: string;
    readonly body?: string;
    /** Null clears the answer, as an item opened again has none. */
    readonly answer?: RecordedAnswer | null;
    readonly targets?: readonly InboxTarget[];
    readonly options?: readonly InboxOption[];
    /** Null clears the detail. */
    readonly detail?: Record<string, Json> | null;
  },
): InboxItemDto {
  // Drizzle's `.set()` wants a mutable array, so `targets` and `options` are copied rather than spread through.
  const { targets, options, ...rest } = patch;
  const set = {
    ...rest,
    ...(targets ? { targets: [...targets] } : {}),
    ...(options ? { options: [...options] } : {}),
    updatedAt: ctx.now,
  };
  const result = ctx.tx
    .update(schema.inboxItems)
    .set(set)
    .where(eq(schema.inboxItems.id, id))
    .run();
  if (result.changes === 0) throw new NotFoundError('inbox item', id);
  const item = getInboxItem(ctx.tx, id);
  ctx.emit({
    type: EventType.InboxChanged,
    entityType: 'inbox',
    entityId: id,
    data: { state: item.state },
  });
  return item;
}

/**
 * Sets who a card is routed to, in routing order, and by whom. `assignee` is the first handle, or the
 * builder when the list is empty. Leaving `triage_pending` is announced as `inbox.triaged`.
 */
export function setInboxRecipients(
  ctx: WriteContext,
  id: InboxItemId,
  input: {
    readonly assignees: readonly string[];
    readonly routedBy: RoutedBy;
    readonly suggestion: {
      readonly personIds: readonly PersonId[];
      readonly confidence: number;
    } | null;
  },
): InboxItemDto {
  const before = getInboxItem(ctx.tx, id);
  const assignees = input.assignees.length > 0 ? [...input.assignees] : [BUILDER_HANDLE];
  // Whoever sets the recipients decides; a stale mark from a failed draft must not override them.
  const marked = before.detail?.[DRAFT_FAILED_KEY] !== undefined;
  const detail = marked
    ? Object.fromEntries(
        Object.entries(before.detail ?? {}).filter(([k]) => k !== DRAFT_FAILED_KEY),
      )
    : undefined;
  ctx.tx
    .update(schema.inboxItems)
    .set({
      ...(detail === undefined ? {} : { detail: Object.keys(detail).length > 0 ? detail : null }),
      assignees,
      assignee: assignees[0] ?? BUILDER_HANDLE,
      routedBy: input.routedBy,
      routeSuggestion: input.suggestion && {
        personIds: [...input.suggestion.personIds],
        confidence: input.suggestion.confidence,
      },
      updatedAt: ctx.now,
    })
    .where(eq(schema.inboxItems.id, id))
    .run();
  const item = getInboxItem(ctx.tx, id);
  ctx.emit({
    type: EventType.InboxChanged,
    entityType: 'inbox',
    entityId: id,
    data: { state: item.state },
  });
  if (before.routedBy === RoutedBy.TriagePending && input.routedBy !== RoutedBy.TriagePending) {
    ctx.emit({
      type: EventType.InboxTriaged,
      entityType: 'inbox',
      entityId: id,
      data: {
        routedBy: input.routedBy,
        toBuilder: item.assignees.length === 1 && item.assignees[0] === BUILDER_HANDLE,
      },
    });
  }
  return item;
}

export function openItemsForWorkstream(db: DbReader, workstreamId: WorkstreamId): InboxItemDto[] {
  return db
    .select()
    .from(schema.inboxItems)
    .where(
      and(
        inArray(schema.inboxItems.state, LIVE_STATES),
        sql`EXISTS (SELECT 1 FROM json_each(${schema.inboxItems.targets}) WHERE json_extract(value, '$.workstreamId') = ${workstreamId})`,
      ),
    )
    .orderBy(asc(schema.inboxItems.createdAt), asc(schema.inboxItems.id))
    .all()
    .map((row) => toDto(db, row));
}

/** A card the builder answered, as a reviewer of its task is shown it. */
export interface AnsweredCard {
  readonly id: InboxItemId;
  readonly kind: InboxKind;
  readonly question: string;
  readonly choice: string;
  readonly note: string | null;
}

/**
 * The cards the builder answered on a task, oldest first: the question, the choice and the note. A
 * permission card is left out (its denials are told to a session on their own) and so is a proposal
 * (its answer files or drops a task, it decides nothing the task's work rests on). A card the builder
 * closed with Park the task is left out too: that is 10db's control over the run, not an answer to the
 * question. A card counts whichever of the task's runs it targets.
 */
export function answeredCardsForTask(db: DbReader, taskId: TaskId): AnsweredCard[] {
  return db
    .select()
    .from(schema.inboxItems)
    .where(
      and(
        inArray(schema.inboxItems.state, ANSWERED_STATES),
        notInArray(schema.inboxItems.kind, ['permission', 'proposal']),
        sql`EXISTS (SELECT 1 FROM json_each(${schema.inboxItems.targets}) AS t JOIN ${schema.workstreams} AS w ON w.id = json_extract(t.value, '$.workstreamId') WHERE w.task_id = ${taskId})`,
      ),
    )
    .orderBy(asc(schema.inboxItems.createdAt), asc(schema.inboxItems.id))
    .all()
    .flatMap((row) =>
      row.answer && row.answer.choice !== PARK_TASK_CHOICE
        ? [
            {
              id: row.id,
              kind: row.kind,
              question: row.title,
              choice: row.answer.choice,
              note: row.answer.note ?? null,
            },
          ]
        : [],
    );
}

/** A call the builder denied, as a later session of the workstream is told about it. */
export interface DeniedPermission {
  readonly toolName: string;
  readonly summary: string;
  readonly note: string | null;
}

/**
 * The permission cards the builder answered with a denial for this workstream, oldest first, at most
 * the newest `limit`. A denial belongs to the workstream, not to the session that asked: every later
 * session is told of it, so a lane does not ask for, or try again, what was refused.
 */
export function deniedPermissionsForWorkstream(
  db: DbReader,
  workstreamId: WorkstreamId,
  limit = 20,
): DeniedPermission[] {
  const rows = db
    .select()
    .from(schema.inboxItems)
    .where(
      and(
        eq(schema.inboxItems.kind, 'permission'),
        inArray(schema.inboxItems.state, ANSWERED_STATES),
        sql`json_extract(${schema.inboxItems.answer}, '$.choice') = 'deny'`,
        sql`EXISTS (SELECT 1 FROM json_each(${schema.inboxItems.targets}) WHERE json_extract(value, '$.workstreamId') = ${workstreamId})`,
      ),
    )
    .orderBy(desc(schema.inboxItems.createdAt), desc(schema.inboxItems.id))
    .limit(limit)
    .all();
  return rows.reverse().flatMap((row) => {
    const toolName = row.detail?.['toolName'];
    const summary = row.detail?.['summary'];
    if (typeof toolName !== 'string' || typeof summary !== 'string') return [];
    return [{ toolName, summary, note: row.answer?.note ?? null }];
  });
}
