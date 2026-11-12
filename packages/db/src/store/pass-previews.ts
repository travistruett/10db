import {
  EventType,
  mintId,
  type InboxItemId,
  type PassId,
  type PassPreview,
  type PassPreviewMarkId,
  type PassTurnId,
  type TaskId,
  type TaskMessageId,
} from '@10db/contracts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import { getPass } from './passes';
import type { DbReader, WriteContext } from './store';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §8.2, §11: how the pass's
// last judged page load went, and the marks on the pages whose turns broke the preview.

export type PassPreviewMarkRow = typeof schema.passPreviewMarks.$inferSelect;

/** How the pass's last judged load went; null before any. */
export function getPassPreview(db: DbReader, passId: PassId): PassPreview | null {
  return (
    db
      .select({ preview: schema.passes.preview })
      .from(schema.passes)
      .where(eq(schema.passes.id, passId))
      .get()?.preview ?? null
  );
}

/** Records how the pass's last judged load went, appending `pass.changed` when that changed it. */
export function setPassPreview(ctx: WriteContext, passId: PassId, preview: PassPreview): void {
  if (getPassPreview(ctx.tx, passId) === preview) return;
  const pass = getPass(ctx.tx, passId);
  ctx.tx
    .update(schema.passes)
    .set({ preview, updatedAt: ctx.now })
    .where(eq(schema.passes.id, passId))
    .run();
  ctx.emit({
    type: EventType.PassChanged,
    entityType: 'pass',
    entityId: passId,
    data: { projectId: pass.projectId, preview },
  });
}

/**
 * Opens a mark on the page whose turn `turnId` broke the preview of `route`, appending
 * `pass.preview_broken`. The page's one open mark is unique: a second throws.
 */
export function insertPreviewMark(
  ctx: WriteContext,
  input: {
    readonly passId: PassId;
    readonly taskId: TaskId;
    readonly turnId: PassTurnId;
    readonly route: string;
    readonly overlay: string | null;
  },
): PassPreviewMarkRow {
  const row: PassPreviewMarkRow = {
    id: mintId('PassPreviewMark'),
    ...input,
    brokenAt: ctx.now,
    turns: 1,
    mendedAt: null,
    cardId: null,
    noticeId: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.passPreviewMarks).values(row).run();
  ctx.emit({
    type: EventType.PassPreviewBroken,
    entityType: 'pass',
    entityId: input.passId,
    data: { passId: input.passId, taskId: input.taskId, route: input.route },
  });
  return row;
}

/** The page's open mark in the pass, if its turns broke the preview and none has mended it. */
export function openPreviewMark(
  db: DbReader,
  passId: PassId,
  taskId: TaskId,
): PassPreviewMarkRow | undefined {
  return db
    .select()
    .from(schema.passPreviewMarks)
    .where(
      and(
        eq(schema.passPreviewMarks.passId, passId),
        eq(schema.passPreviewMarks.taskId, taskId),
        isNull(schema.passPreviewMarks.mendedAt),
      ),
    )
    .get();
}

/** The pass's open marks, oldest first. */
export function listOpenPreviewMarks(db: DbReader, passId: PassId): PassPreviewMarkRow[] {
  return db
    .select()
    .from(schema.passPreviewMarks)
    .where(
      and(eq(schema.passPreviewMarks.passId, passId), isNull(schema.passPreviewMarks.mendedAt)),
    )
    .orderBy(asc(schema.passPreviewMarks.brokenAt), asc(schema.passPreviewMarks.id))
    .all();
}

function getMark(db: DbReader, id: PassPreviewMarkId): PassPreviewMarkRow | undefined {
  return db.select().from(schema.passPreviewMarks).where(eq(schema.passPreviewMarks.id, id)).get();
}

function emitMarkChanged(
  ctx: WriteContext,
  mark: PassPreviewMarkRow,
  data: { turns: number },
): void {
  ctx.emit({
    type: EventType.PassChanged,
    entityType: 'pass',
    entityId: mark.passId,
    data: { projectId: getPass(ctx.tx, mark.passId).projectId, previewTurns: data.turns },
  });
}

/** One more turn of the page loaded the preview broken; answers how many turns running it has. */
export function countPreviewTurn(ctx: WriteContext, id: PassPreviewMarkId): number {
  const mark = getMark(ctx.tx, id);
  if (mark?.mendedAt !== null) return 0;
  const turns = mark.turns + 1;
  ctx.tx
    .update(schema.passPreviewMarks)
    .set({ turns, updatedAt: ctx.now })
    .where(eq(schema.passPreviewMarks.id, id))
    .run();
  emitMarkChanged(ctx, mark, { turns });
  return turns;
}

/** Records the Move card the mark raised, once; answers whether this call recorded it. */
export function setPreviewMarkCard(
  ctx: WriteContext,
  id: PassPreviewMarkId,
  cardId: InboxItemId,
): boolean {
  return (
    ctx.tx
      .update(schema.passPreviewMarks)
      .set({ cardId, updatedAt: ctx.now })
      .where(and(eq(schema.passPreviewMarks.id, id), isNull(schema.passPreviewMarks.cardId)))
      .run().changes > 0
  );
}

/** Records the thread notice that offers the broken preview to the agent. */
export function setPreviewMarkNotice(
  ctx: WriteContext,
  id: PassPreviewMarkId,
  noticeId: TaskMessageId,
): void {
  ctx.tx
    .update(schema.passPreviewMarks)
    .set({ noticeId, updatedAt: ctx.now })
    .where(eq(schema.passPreviewMarks.id, id))
    .run();
}

/**
 * A turn of the page loaded the preview cleanly: mends its mark once, appending
 * `pass.preview_mended`; answers the mended row, or null for a mark already mended.
 */
export function mendPreviewMark(
  ctx: WriteContext,
  id: PassPreviewMarkId,
): PassPreviewMarkRow | null {
  const written = ctx.tx
    .update(schema.passPreviewMarks)
    .set({ mendedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(schema.passPreviewMarks.id, id), isNull(schema.passPreviewMarks.mendedAt)))
    .run();
  if (written.changes === 0) return null;
  const mark = getMark(ctx.tx, id);
  if (mark === undefined) return null;
  ctx.emit({
    type: EventType.PassPreviewMended,
    entityType: 'pass',
    entityId: mark.passId,
    data: { passId: mark.passId, taskId: mark.taskId },
  });
  return mark;
}
