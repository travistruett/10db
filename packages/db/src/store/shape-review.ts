import {
  ConflictError,
  EventType,
  InboxKind,
  mintId,
  NotFoundError,
  ShapeFindingKind,
  ShapeFindingState,
  ShapeReviewer,
  type GoalId,
  type ProjectId,
  type QuestionMeasureDto,
  type ShapeFindingId,
  type ShapeFindingSeverity,
  type ShapeId,
  type TaskId,
} from '@10db/contracts';
import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import * as schema from '../schema';
import { getAppSetting, setAppSetting } from './settings';
import { getShape } from './shapes';
import type { DbReader, WriteContext } from './store';

// Shape spec §7, §13. A conversation's reviewers' findings, the rehearsal's marks, an effort's spec,
// the project's one-way paths and the question-card measure. The daemon's shape module decides what
// they say; these functions keep and read them.

export type ShapeFindingRow = typeof schema.shapeFindings.$inferSelect;

export interface NewShapeFinding {
  readonly shapeId: ShapeId;
  readonly effortKey: string;
  readonly taskKey: string | null;
  readonly reviewer: ShapeReviewer;
  readonly kind: ShapeFindingKind;
  readonly severity: ShapeFindingSeverity | null;
  readonly text: string;
  readonly round: number;
  readonly taskHash: string | null;
}

const announce = (ctx: WriteContext, shapeId: ShapeId): void => {
  ctx.emit({
    type: EventType.ShapeChanged,
    entityType: 'shape',
    entityId: shapeId,
    data: { projectId: getShape(ctx.tx, shapeId).projectId },
  });
};

/** Writes an open finding and tells the screen. */
export function insertShapeFinding(ctx: WriteContext, input: NewShapeFinding): ShapeFindingRow {
  const row: ShapeFindingRow = {
    id: mintId('ShapeFinding'),
    ...input,
    state: ShapeFindingState.Open,
    how: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.shapeFindings).values(row).run();
  announce(ctx, input.shapeId);
  return row;
}

export function getShapeFinding(db: DbReader, id: ShapeFindingId): ShapeFindingRow {
  const row = db.select().from(schema.shapeFindings).where(eq(schema.shapeFindings.id, id)).get();
  if (!row) throw new NotFoundError('shape finding', id);
  return row;
}

/** A conversation's findings, oldest first. */
export function listShapeFindings(db: DbReader, shapeId: ShapeId): ShapeFindingRow[] {
  return db
    .select()
    .from(schema.shapeFindings)
    .where(eq(schema.shapeFindings.shapeId, shapeId))
    .orderBy(asc(schema.shapeFindings.id))
    .all();
}

/**
 * Resolves a finding (the session answered it) or dismisses it (the builder did), with a one-line
 * how. A finding settles once; a second call is a conflict.
 */
export function settleShapeFinding(
  ctx: WriteContext,
  id: ShapeFindingId,
  state: typeof ShapeFindingState.Resolved | typeof ShapeFindingState.Dismissed,
  how: string,
): ShapeFindingRow {
  const before = getShapeFinding(ctx.tx, id);
  if (before.state !== ShapeFindingState.Open)
    throw new ConflictError(`That finding is already ${before.state}`);
  ctx.tx
    .update(schema.shapeFindings)
    .set({ state, how, updatedAt: ctx.now })
    .where(eq(schema.shapeFindings.id, id))
    .run();
  announce(ctx, before.shapeId);
  return { ...before, state, how, updatedAt: ctx.now };
}

/**
 * Resolves a task's open rehearsal questions, as a builder's edit does ("answered by your edit").
 * Answers how many it settled; findings of the other reviewers are left alone.
 */
export function settleOpenQuestionsOfTask(
  ctx: WriteContext,
  shapeId: ShapeId,
  taskKey: string,
  how: string,
): number {
  const result = ctx.tx
    .update(schema.shapeFindings)
    .set({ state: ShapeFindingState.Resolved, how, updatedAt: ctx.now })
    .where(
      and(
        eq(schema.shapeFindings.shapeId, shapeId),
        eq(schema.shapeFindings.taskKey, taskKey),
        eq(schema.shapeFindings.reviewer, ShapeReviewer.Rehearsal),
        eq(schema.shapeFindings.kind, ShapeFindingKind.Question),
        eq(schema.shapeFindings.state, ShapeFindingState.Open),
      ),
    )
    .run();
  if (result.changes > 0) announce(ctx, shapeId);
  return result.changes;
}

// --- The rehearsal's marks ----------------------------------------------------------------------

export type ShapeRehearsalRow = typeof schema.shapeRehearsals.$inferSelect;

/** Marks a task read at a content hash; a second write for the same hash replaces the count. */
export function recordRehearsal(
  ctx: WriteContext,
  input: Omit<ShapeRehearsalRow, 'createdAt'>,
): void {
  ctx.tx
    .insert(schema.shapeRehearsals)
    .values({ ...input, createdAt: ctx.now })
    .onConflictDoUpdate({
      target: [
        schema.shapeRehearsals.shapeId,
        schema.shapeRehearsals.taskKey,
        schema.shapeRehearsals.hash,
      ],
      set: { questions: input.questions, round: input.round },
    })
    .run();
  announce(ctx, input.shapeId);
}

export function listRehearsals(db: DbReader, shapeId: ShapeId): ShapeRehearsalRow[] {
  return db
    .select()
    .from(schema.shapeRehearsals)
    .where(eq(schema.shapeRehearsals.shapeId, shapeId))
    .orderBy(asc(schema.shapeRehearsals.taskKey), asc(schema.shapeRehearsals.createdAt))
    .all();
}

// --- Attachments: an effort's spec --------------------------------------------------------------

export type ShapeAttachmentRow = typeof schema.shapeAttachments.$inferSelect;

/** Keeps an effort's spec or eval; writing it again replaces the earlier text. */
export function upsertShapeAttachment(
  ctx: WriteContext,
  input: {
    readonly shapeId: ShapeId;
    readonly kind: 'spec' | 'eval';
    readonly key: string;
    readonly body: string;
  },
): void {
  const held = ctx.tx
    .select({ id: schema.shapeAttachments.id })
    .from(schema.shapeAttachments)
    .where(
      and(
        eq(schema.shapeAttachments.shapeId, input.shapeId),
        eq(schema.shapeAttachments.key, input.key),
        eq(schema.shapeAttachments.kind, input.kind),
      ),
    )
    .get();
  if (held)
    ctx.tx
      .update(schema.shapeAttachments)
      .set({ body: input.body, updatedAt: ctx.now })
      .where(eq(schema.shapeAttachments.id, held.id))
      .run();
  else
    ctx.tx
      .insert(schema.shapeAttachments)
      .values({
        id: mintId('ShapeAttachment'),
        ...input,
        goalId: null,
        taskId: null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run();
  announce(ctx, input.shapeId);
}

export function listShapeAttachments(db: DbReader, shapeId: ShapeId): ShapeAttachmentRow[] {
  return db
    .select()
    .from(schema.shapeAttachments)
    .where(eq(schema.shapeAttachments.shapeId, shapeId))
    .orderBy(asc(schema.shapeAttachments.id))
    .all();
}

/** Convert linked an effort to the goal or task it made: its attachments follow. */
export function linkShapeAttachments(
  ctx: WriteContext,
  shapeId: ShapeId,
  key: string,
  target: { readonly goalId: GoalId } | { readonly taskId: TaskId },
): void {
  ctx.tx
    .update(schema.shapeAttachments)
    .set({
      goalId: 'goalId' in target ? target.goalId : null,
      taskId: 'taskId' in target ? target.taskId : null,
      updatedAt: ctx.now,
    })
    .where(and(eq(schema.shapeAttachments.shapeId, shapeId), eq(schema.shapeAttachments.key, key)))
    .run();
}

// --- The project's one-way paths ----------------------------------------------------------------

const oneWayKey = (projectId: ProjectId): string => `shape.oneWayPaths.${projectId}`;

/** The globs the builder set for a project, or null while none were set (the defaults apply). */
export function getOneWayPaths(db: DbReader, projectId: ProjectId): string[] | null {
  const value = getAppSetting(db, oneWayKey(projectId));
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : null;
}

export function setOneWayPaths(
  ctx: WriteContext,
  projectId: ProjectId,
  paths: readonly string[],
): void {
  setAppSetting(ctx, oneWayKey(projectId), [...paths]);
}

// --- The measure --------------------------------------------------------------------------------

/**
 * Inbox question cards per task that a conversation converted, against the other tasks of the same
 * projects (§7 Measure). Only tasks that started count: a card lands on a workstream. A card counts
 * once for each task it targets.
 */
export function questionCardRates(db: DbReader): QuestionMeasureDto {
  const links = db
    .select({ taskId: schema.shapeLinks.taskId })
    .from(schema.shapeLinks)
    .where(isNotNull(schema.shapeLinks.taskId))
    .all();
  const convertedTasks = new Set<TaskId>(
    links.flatMap((l) => (l.taskId === null ? [] : [l.taskId])),
  );
  const empty = { converted: { tasks: 0, cards: 0 }, other: { tasks: 0, cards: 0 } };
  if (convertedTasks.size === 0) return empty;
  const projects = db
    .selectDistinct({ projectId: schema.tasks.projectId })
    .from(schema.tasks)
    .where(inArray(schema.tasks.id, [...convertedTasks]))
    .all()
    .map((p) => p.projectId);
  const workstreams = db
    .select({ id: schema.workstreams.id, taskId: schema.workstreams.taskId })
    .from(schema.workstreams)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.workstreams.taskId))
    .where(and(inArray(schema.tasks.projectId, projects), ne(schema.tasks.status, 'cancelled')))
    .all();
  const taskOf = new Map(workstreams.map((w) => [w.id as string, w.taskId]));
  const out = structuredClone(empty);
  const group = (taskId: TaskId) => (convertedTasks.has(taskId) ? out.converted : out.other);
  for (const taskId of new Set(workstreams.map((w) => w.taskId))) group(taskId).tasks += 1;
  const cards = db
    .select({ targets: schema.inboxItems.targets })
    .from(schema.inboxItems)
    .where(
      and(
        eq(schema.inboxItems.kind, InboxKind.Question),
        inArray(schema.inboxItems.projectId, projects),
      ),
    )
    .all();
  for (const card of cards) {
    const hit = new Set<TaskId>();
    for (const target of card.targets) {
      const taskId = taskOf.get(target.workstreamId);
      if (taskId !== undefined) hit.add(taskId);
    }
    for (const taskId of hit) group(taskId).cards += 1;
  }
  return out;
}
