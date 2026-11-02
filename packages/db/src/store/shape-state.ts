import {
  EventType,
  mintId,
  NotFoundError,
  type DecisionId,
  type GoalId,
  type ShapeDto,
  type ShapeId,
  type ShapeLinkId,
  type ShapeMessageAuthor,
  type ShapeMessageDto,
  type ShapeMessageId,
  type ShapeMessageKind,
  type ShapeProposalId,
  type ShapeProposalKind,
  type ShapeProposalState,
  type ShapeState,
  type TaskId,
} from '@10db/contracts';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type { Json } from '../json';
import * as schema from '../schema';
import { getShape } from './shapes';
import type { DbReader, WriteContext } from './store';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §5.3, §6 Rows, §11.
// The daemon's shape module decides what these rows say; these functions only keep them.

// --- The conversation ---------------------------------------------------------------------------

export interface ShapePatch {
  readonly title?: string;
  readonly state?: ShapeState;
  /** The Claude Code session the conversation resumes; null forgets it. */
  readonly sdkSessionId?: string | null;
  /** Set for good by the builder's first Propose. */
  readonly proposeUnlocked?: true;
  readonly round?: number;
}

/** Changes a conversation and announces it. */
export function patchShape(ctx: WriteContext, id: ShapeId, patch: ShapePatch): ShapeDto {
  const before = getShape(ctx.tx, id);
  ctx.tx
    .update(schema.shapes)
    .set({ ...patch, updatedAt: ctx.now })
    .where(eq(schema.shapes.id, id))
    .run();
  ctx.emit({
    type: EventType.ShapeChanged,
    entityType: 'shape',
    entityId: id,
    data: { projectId: before.projectId },
  });
  return getShape(ctx.tx, id);
}

/** The Claude Code session a conversation resumes, or null before its first turn. */
export function getShapeSdkSessionId(db: DbReader, id: ShapeId): string | null {
  const row = db
    .select({ sdkSessionId: schema.shapes.sdkSessionId })
    .from(schema.shapes)
    .where(eq(schema.shapes.id, id))
    .get();
  if (!row) throw new NotFoundError('shape', id);
  return row.sdkSessionId;
}

// --- The transcript -----------------------------------------------------------------------------

type MessageRow = typeof schema.shapeMessages.$inferSelect;

const toMessageDto = (row: MessageRow): ShapeMessageDto => ({
  id: row.id,
  shapeId: row.shapeId,
  author: row.author,
  kind: row.kind,
  body: row.body,
  createdAt: row.createdAt,
});

/** Appends a row to the transcript. */
export function insertShapeMessage(
  ctx: WriteContext,
  shapeId: ShapeId,
  input: {
    readonly author: ShapeMessageAuthor;
    readonly kind: ShapeMessageKind;
    readonly body: string;
  },
): ShapeMessageDto {
  const shape = getShape(ctx.tx, shapeId);
  const row: MessageRow = {
    id: mintId('ShapeMessage'),
    shapeId,
    author: input.author,
    kind: input.kind,
    body: input.body,
    createdAt: ctx.now,
  };
  ctx.tx.insert(schema.shapeMessages).values(row).run();
  ctx.emit({
    type: EventType.ShapeChanged,
    entityType: 'shape',
    entityId: shapeId,
    data: { projectId: shape.projectId },
  });
  return toMessageDto(row);
}

/** The conversation's transcript, oldest first; `after` skips up to and including that message. */
export function listShapeMessages(
  db: DbReader,
  shapeId: ShapeId,
  after?: ShapeMessageId,
): ShapeMessageDto[] {
  return db
    .select()
    .from(schema.shapeMessages)
    .where(
      after === undefined
        ? eq(schema.shapeMessages.shapeId, shapeId)
        : and(eq(schema.shapeMessages.shapeId, shapeId), gt(schema.shapeMessages.id, after)),
    )
    .orderBy(asc(schema.shapeMessages.id))
    .all()
    .map(toMessageDto);
}

/** The newest `count` rows of the transcript, oldest first. */
export function lastShapeMessages(
  db: DbReader,
  shapeId: ShapeId,
  count: number,
): ShapeMessageDto[] {
  return db
    .select()
    .from(schema.shapeMessages)
    .where(eq(schema.shapeMessages.shapeId, shapeId))
    .orderBy(desc(schema.shapeMessages.id))
    .limit(count)
    .all()
    .reverse()
    .map(toMessageDto);
}

// --- Proposals ----------------------------------------------------------------------------------

export type ShapeProposalRow = typeof schema.shapeProposals.$inferSelect;

export interface NewShapeProposal {
  readonly shapeId: ShapeId;
  readonly key: string;
  readonly kind: ShapeProposalKind;
  readonly state: ShapeProposalState;
  readonly round: number;
  readonly pinned: readonly string[];
  readonly body: Json;
  readonly taskHashes: ShapeProposalRow['taskHashes'];
  readonly sourceMessageIds: readonly ShapeMessageId[];
}

export function insertShapeProposal(ctx: WriteContext, input: NewShapeProposal): ShapeProposalRow {
  const row: ShapeProposalRow = {
    id: mintId('ShapeProposal'),
    ...input,
    pinned: [...input.pinned],
    sourceMessageIds: [...input.sourceMessageIds],
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.shapeProposals).values(row).run();
  return row;
}

export type ShapeProposalPatch = Partial<
  Pick<ShapeProposalRow, 'state' | 'round' | 'pinned' | 'body' | 'taskHashes' | 'sourceMessageIds'>
>;

export function patchShapeProposal(
  ctx: WriteContext,
  id: ShapeProposalId,
  patch: ShapeProposalPatch,
): void {
  ctx.tx
    .update(schema.shapeProposals)
    .set({ ...patch, updatedAt: ctx.now })
    .where(eq(schema.shapeProposals.id, id))
    .run();
}

export function getShapeProposal(db: DbReader, id: ShapeProposalId): ShapeProposalRow {
  const row = db.select().from(schema.shapeProposals).where(eq(schema.shapeProposals.id, id)).get();
  if (!row) throw new NotFoundError('shape proposal', id);
  return row;
}

/** Every proposal row of the conversation, tombstones included, in the order they were made. */
export function listShapeProposals(db: DbReader, shapeId: ShapeId): ShapeProposalRow[] {
  return db
    .select()
    .from(schema.shapeProposals)
    .where(eq(schema.shapeProposals.shapeId, shapeId))
    .orderBy(asc(schema.shapeProposals.id))
    .all();
}

// --- Links --------------------------------------------------------------------------------------

export type ShapeLinkRow = typeof schema.shapeLinks.$inferSelect;

/** What Convert made from a proposal: exactly one of a goal, a task and a decision. */
export type ShapeLinkTarget =
  { readonly goalId: GoalId } | { readonly taskId: TaskId } | { readonly decisionId: DecisionId };

export function insertShapeLink(
  ctx: WriteContext,
  input: {
    readonly shapeId: ShapeId;
    readonly proposalId: ShapeProposalId;
    readonly key: string;
  } & ShapeLinkTarget,
): ShapeLinkRow {
  const row: ShapeLinkRow = {
    id: mintId('ShapeLink') satisfies ShapeLinkId,
    shapeId: input.shapeId,
    proposalId: input.proposalId,
    key: input.key,
    goalId: 'goalId' in input ? input.goalId : null,
    taskId: 'taskId' in input ? input.taskId : null,
    decisionId: 'decisionId' in input ? input.decisionId : null,
    createdAt: ctx.now,
  };
  ctx.tx.insert(schema.shapeLinks).values(row).run();
  return row;
}

export function listShapeLinks(db: DbReader, shapeId: ShapeId): ShapeLinkRow[] {
  return db
    .select()
    .from(schema.shapeLinks)
    .where(eq(schema.shapeLinks.shapeId, shapeId))
    .orderBy(asc(schema.shapeLinks.id))
    .all();
}

/** The link naming a goal Convert made, or undefined for a goal no conversation made. */
export function findShapeLinkOfGoal(db: DbReader, goalId: GoalId): ShapeLinkRow | undefined {
  return db.select().from(schema.shapeLinks).where(eq(schema.shapeLinks.goalId, goalId)).get();
}

/** Deletes the links of one proposal, when Remove Draft Goal makes it pending again. */
export function deleteShapeLinksOf(ctx: WriteContext, proposalId: ShapeProposalId): void {
  ctx.tx.delete(schema.shapeLinks).where(eq(schema.shapeLinks.proposalId, proposalId)).run();
}
