import {
  EventType,
  InboxState,
  mintId,
  NotFoundError,
  type InboxAnswer,
  type InboxItemDto,
  type InboxItemId,
  type InboxKind,
  type InboxOption,
  type InboxTarget,
  type ProjectId,
  type QuestionCategory,
  type Urgency,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema';
import type { Json } from '../json';
import { assigneeFor } from './routing-rules';
import type { DbReader, WriteContext } from './store';

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
}

const LIVE_STATES: InboxState[] = [InboxState.Open, InboxState.Answered, InboxState.Delivering];

/** Every column except `foldKey`, which stays internal to folding. */
function toDto(row: typeof schema.inboxItems.$inferSelect): InboxItemDto {
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
    detail: row.detail,
    answer: row.answer,
    targets: row.targets,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The areas the targeted workstreams' tasks claim, so a routing rule can narrow by area. */
function targetAreas(db: DbReader, targets: readonly InboxTarget[]): string[] {
  const areas = new Set<string>();
  for (const target of targets) {
    const row = db
      .select({ areas: schema.tasks.areas })
      .from(schema.workstreams)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.workstreams.taskId))
      .where(eq(schema.workstreams.id, target.workstreamId))
      .get();
    for (const area of row?.areas ?? []) areas.add(area);
  }
  return [...areas];
}

export function insertInboxItem(ctx: WriteContext, item: NewInboxItem): InboxItemDto {
  const row = {
    id: mintId('InboxItem'),
    ...item,
    options: [...item.options],
    targets: [...item.targets],
    state: InboxState.Open,
    assignee: assigneeFor(ctx.tx, item.projectId, item.category, targetAreas(ctx.tx, item.targets)),
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
  return toDto(row);
}

export function getInboxItem(db: DbReader, id: InboxItemId): InboxItemDto {
  const row = db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id)).get();
  if (!row) throw new NotFoundError('inbox item', id);
  return toDto(row);
}

const URGENCY_ORDER = sql`CASE ${schema.inboxItems.urgency} WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END`;

export function listInbox(
  db: DbReader,
  filter: { states?: readonly InboxState[]; projectId?: ProjectId } = {},
): InboxItemDto[] {
  const where: SQL[] = [];
  if (filter.states) where.push(inArray(schema.inboxItems.state, [...filter.states]));
  if (filter.projectId) where.push(eq(schema.inboxItems.projectId, filter.projectId));
  return db
    .select()
    .from(schema.inboxItems)
    .where(and(...where))
    .orderBy(URGENCY_ORDER, asc(schema.inboxItems.createdAt), asc(schema.inboxItems.id))
    .all()
    .map(toDto);
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
  return row ? toDto(row) : undefined;
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
    readonly answer?: InboxAnswer;
    readonly targets?: readonly InboxTarget[];
    readonly options?: readonly InboxOption[];
    readonly detail?: Record<string, Json>;
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
    .map(toDto);
}
