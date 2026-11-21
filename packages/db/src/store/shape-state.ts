import { randomUUID } from 'node:crypto';
import type { ShapeId } from '@10db/contracts';
import {
  ConversationItemKind,
  EventType,
  mintId,
  NotFoundError,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeProposalBody,
  ShapeProposalState,
  type DecisionId,
  type GoalId,
  type PrincipleId,
  type ShapeDto,
  type ConversationFileId,
  type ShapeLinkId,
  type ShapeMessageDto,
  type ConversationItemId,
  type ShapeProposalId,
  type ShapeProposalKind,
  type ShapeQuestionId,
  type ShapeState,
  type TaskId,
} from '@10db/contracts';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Json } from '../json';
import * as schema from '../schema';
import {
  getFile,
  insertFiles,
  listFiles,
  listUntoldFiles,
  markFilesInline,
  markFilesTold,
  markFilesUnreadableTold,
  type ConversationFileRow,
} from './conversation-files';
import {
  getItem,
  insertItem,
  lastItems,
  listItems,
  type ConversationItemRow,
} from './conversation-items';
import { patchConversation } from './conversations';
import { getShape, planOfConversation, shapeConversation } from './shapes';
import type { DbReader, WriteContext } from './store';
import { shapeItemOf, shapeMessageOf } from './transcript-kinds';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §5.3, §6 Rows, §11.
// The daemon's shape module decides what these rows say; these functions only keep them.

// --- The conversation ---------------------------------------------------------------------------

export interface ShapePatch {
  readonly title?: string;
  readonly state?: ShapeState;
  /** The Claude Code session the conversation resumes; null forgets it. */
  readonly sdkSessionId?: string | null;
  readonly round?: number;
  /** The model alias the builder chose; null goes back to the `plan` role's. */
  readonly model?: string | null;
}

/** Changes a conversation and announces it; its session and model are kept on its conversation row. */
export function patchShape(ctx: WriteContext, id: ShapeId, patch: ShapePatch): ShapeDto {
  const before = getShape(ctx.tx, id);
  const { sdkSessionId, model, ...own } = patch;
  ctx.tx
    .update(schema.shapes)
    .set({ ...own, updatedAt: ctx.now })
    .where(eq(schema.shapes.id, id))
    .run();
  if (sdkSessionId !== undefined || model !== undefined)
    patchConversation(ctx, shapeConversation(ctx.tx, id).id, {
      ...(sdkSessionId === undefined ? {} : { providerSessionId: sdkSessionId }),
      ...(model === undefined ? {} : { model }),
    });
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
  getShape(db, id);
  return shapeConversation(db, id).providerSessionId;
}

// --- The transcript -----------------------------------------------------------------------------

// Plan's rows are its conversation's items (decision
// 2026-11-13-one-conversation-store-keeps-ids-and-orders-by-seq.md), mapped by transcript-kinds.

const toMessageDto = (shapeId: ShapeId, item: ConversationItemRow): ShapeMessageDto | null => {
  const message = shapeMessageOf(item);
  return message === null ? null : { id: item.id, shapeId, ...message, createdAt: item.createdAt };
};

const toMessageDtos = (shapeId: ShapeId, items: readonly ConversationItemRow[]) =>
  items.flatMap((item) => toMessageDto(shapeId, item) ?? []);

/**
 * Appends a row to the transcript. A builder's message is delivered as it is written: Plan sends it
 * to its session in the same turn, and keeps no queue a restart could find.
 */
export function insertShapeMessage(
  ctx: WriteContext,
  shapeId: ShapeId,
  input: {
    readonly author: ShapeMessageAuthor;
    readonly kind: ShapeMessageKind;
    readonly body: string;
    /** A builder message waits for a turn to take it, rather than reading as delivered now. */
    readonly queued?: boolean;
    /** What a press asks the session to do, which makes it a turn starter (Propose, Rehearse). */
    readonly prompt?: string;
    /** The tasks a Rehearse press lists, each at the hash it was proposed at. */
    readonly rehearsing?: readonly { readonly taskKey: string; readonly hash: string }[];
  },
): ShapeMessageDto {
  const { queued, prompt, rehearsing, ...message } = input;
  const shape = getShape(ctx.tx, shapeId);
  const builderText =
    message.author === ShapeMessageAuthor.Builder && message.kind === ShapeMessageKind.Text;
  const item = shapeItemOf({ ...message, createdAt: ctx.now }, randomUUID());
  const pressed =
    item.kind === ConversationItemKind.ShapeEvent &&
    typeof item.body === 'object' &&
    item.body !== null &&
    !Array.isArray(item.body) &&
    (prompt !== undefined || rehearsing !== undefined)
      ? {
          ...item.body,
          ...(prompt === undefined ? {} : { prompt }),
          ...(rehearsing === undefined
            ? {}
            : { rehearsing: rehearsing.map((t) => ({ taskKey: t.taskKey, hash: t.hash })) }),
        }
      : item.body;
  const row = insertItem(ctx, shapeConversation(ctx.tx, shapeId).id, {
    ...item,
    body: pressed,
    deliveredAt: builderText && queued !== true ? ctx.now : null,
  });
  ctx.emit({
    type: EventType.ShapeChanged,
    entityType: 'shape',
    entityId: shapeId,
    data: { projectId: shape.projectId },
  });
  return { id: row.id, shapeId, ...message, createdAt: row.createdAt };
}

/** The conversation's transcript, oldest first; `after` skips up to and including that message. */
export function listShapeMessages(
  db: DbReader,
  shapeId: ShapeId,
  after?: ConversationItemId,
): ShapeMessageDto[] {
  const conversation = shapeConversation(db, shapeId).id;
  if (after === undefined) return toMessageDtos(shapeId, listItems(db, conversation));
  const from = getItem(db, after);
  if (from.conversationId !== conversation) throw new NotFoundError('shape message', after);
  return toMessageDtos(shapeId, listItems(db, conversation, { afterSeq: from.seq }));
}

/** The newest `count` rows of the transcript, oldest first. */
export function lastShapeMessages(
  db: DbReader,
  shapeId: ShapeId,
  count: number,
): ShapeMessageDto[] {
  return toMessageDtos(shapeId, lastItems(db, shapeConversation(db, shapeId).id, count));
}

// --- Proposals ----------------------------------------------------------------------------------

export type ShapeProposalRow = typeof schema.shapeProposals.$inferSelect;

export interface NewShapeProposal {
  readonly shapeId: ShapeId;
  readonly key: string;
  readonly kind: ShapeProposalKind;
  readonly state: ShapeProposalState;
  readonly round: number;
  readonly createdRound: number;
  readonly pinned: readonly string[];
  readonly body: Json;
  readonly taskHashes: ShapeProposalRow['taskHashes'];
  readonly sourceMessageIds: readonly ConversationItemId[];
}

export function insertShapeProposal(ctx: WriteContext, input: NewShapeProposal): ShapeProposalRow {
  const row: ShapeProposalRow = {
    id: mintId('ShapeProposal'),
    ...input,
    pinned: [...input.pinned],
    sourceMessageIds: [...input.sourceMessageIds],
    acceptId: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.shapeProposals).values(row).run();
  return row;
}

export type ShapeProposalPatch = Partial<
  Pick<
    ShapeProposalRow,
    | 'state'
    | 'round'
    | 'createdRound'
    | 'pinned'
    | 'body'
    | 'taskHashes'
    | 'sourceMessageIds'
    | 'acceptId'
  >
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

// --- Files --------------------------------------------------------------------------------------

/** A file dropped into a conversation, as Plan reads it. */
export interface ShapeFileRow {
  readonly id: ConversationFileId;
  readonly shapeId: ShapeId;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  /** Where the daemon copied it, under the data directory. */
  readonly storedPath: string;
  /** When a turn first carried it to Claude; null until then. */
  readonly toldAt: string | null;
  /** Whether the live session's history holds it as an image block. */
  readonly inlineSent: boolean;
  /** When a notice first told the builder Claude can't Read this image; null until then. */
  readonly unreadableToldAt: string | null;
  readonly createdAt: string;
}

const toShapeFile = (shapeId: ShapeId, row: ConversationFileRow): ShapeFileRow => ({
  id: row.id,
  shapeId,
  name: row.name,
  mediaType: row.mediaType,
  size: row.size,
  storedPath: row.storedPath,
  toldAt: row.toldAt,
  inlineSent: row.inlineSent,
  unreadableToldAt: row.unreadableToldAt,
  createdAt: row.createdAt,
});

export function insertShapeFile(
  ctx: WriteContext,
  input: {
    readonly shapeId: ShapeId;
    readonly name: string;
    readonly mediaType: string;
    readonly size: number;
    readonly storedPath: string;
  },
): ShapeFileRow {
  const { shapeId, ...file } = input;
  const shape = getShape(ctx.tx, shapeId);
  const [row] = insertFiles(ctx, shapeConversation(ctx.tx, shapeId).id, null, [
    { ...file, sha256: null },
  ]);
  if (row === undefined) throw new Error('insertFiles wrote no row for one file');
  ctx.emit({
    type: EventType.ShapeChanged,
    entityType: 'shape',
    entityId: shapeId,
    data: { projectId: shape.projectId },
  });
  return toShapeFile(shapeId, row);
}

/** A plan's file is one of its conversation's with no item; a pasted picture belongs to a message. */
const isPlanFile = (row: ConversationFileRow): boolean => row.itemId === null;

export function getShapeFile(db: DbReader, id: ConversationFileId): ShapeFileRow {
  const row = getFile(db, id);
  // A picture pasted with a message carries its item and is no plan file.
  const shapeId = row.itemId === null ? planOfConversation(db, row.conversationId) : null;
  if (shapeId === null) throw new NotFoundError('shape file', id);
  return toShapeFile(shapeId, row);
}

/** The conversation's files, oldest first. */
export function listShapeFiles(db: DbReader, shapeId: ShapeId): ShapeFileRow[] {
  return listFiles(db, shapeConversation(db, shapeId).id)
    .filter(isPlanFile)
    .map((row) => toShapeFile(shapeId, row));
}

/** The conversation's files no turn has carried to Claude yet, oldest first. */
export function listUntoldShapeFiles(db: DbReader, shapeId: ShapeId): ShapeFileRow[] {
  return listUntoldFiles(db, shapeConversation(db, shapeId).id)
    .filter(isPlanFile)
    .map((row) => toShapeFile(shapeId, row));
}

/** Records that a turn carried these files to Claude; one already told keeps its first time. */
export function markShapeFilesTold(ctx: WriteContext, ids: readonly ConversationFileId[]): void {
  markFilesTold(ctx, ids);
}

/** Records that a notice named these images as ones Claude can't Read; one already named keeps its first time. */
export function markShapeFilesUnreadableTold(
  ctx: WriteContext,
  ids: readonly ConversationFileId[],
): void {
  markFilesUnreadableTold(ctx, ids);
}

/**
 * Records which files the turn just sent carried as image blocks. A `fresh` session starts with no
 * earlier block, so it first clears the mark on every file of the conversation.
 */
export function markShapeFilesInline(
  ctx: WriteContext,
  shapeId: ShapeId,
  ids: readonly ConversationFileId[],
  fresh: boolean,
): void {
  markFilesInline(ctx, shapeConversation(ctx.tx, shapeId).id, ids, fresh);
}

export function countShapeFiles(db: DbReader, shapeId: ShapeId): number {
  return listShapeFiles(db, shapeId).length;
}

// --- Links --------------------------------------------------------------------------------------

export type ShapeLinkRow = typeof schema.shapeLinks.$inferSelect;

/** What Convert made from a proposal: exactly one of a goal, a task, a decision, a principle and a question. */
export type ShapeLinkTarget =
  | { readonly goalId: GoalId }
  | { readonly taskId: TaskId }
  | { readonly decisionId: DecisionId }
  | { readonly principleId: PrincipleId }
  | { readonly questionId: ShapeQuestionId };

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
    principleId: 'principleId' in input ? input.principleId : null,
    questionId: 'questionId' in input ? input.questionId : null,
    sizeToldAt: null,
    createdAt: ctx.now,
  };
  ctx.tx.insert(schema.shapeLinks).values(row).run();
  return row;
}

/** Records that a turn told Claude these tasks mis-sized; one already told keeps its first time. */
export function markShapeLinksSizeTold(ctx: WriteContext, ids: readonly ShapeLinkId[]): void {
  if (ids.length === 0) return;
  ctx.tx
    .update(schema.shapeLinks)
    .set({ sizeToldAt: ctx.now })
    .where(and(inArray(schema.shapeLinks.id, [...ids]), isNull(schema.shapeLinks.sizeToldAt)))
    .run();
}

export type ShapeQuestionRow = typeof schema.shapeQuestions.$inferSelect;

/** A question Convert stores for goals phase 3 to send; it belongs to a goal or a task, or to neither. */
export function insertShapeQuestion(
  ctx: WriteContext,
  input: {
    readonly shapeId: ShapeId;
    readonly proposalId: ShapeProposalId;
    readonly key: string;
    readonly text: string;
    readonly forWho: string;
    readonly sourceMessageIds: readonly ConversationItemId[];
    readonly goalId?: GoalId;
    readonly taskId?: TaskId;
  },
): ShapeQuestionRow {
  const row: ShapeQuestionRow = {
    id: mintId('ShapeQuestion') satisfies ShapeQuestionId,
    shapeId: input.shapeId,
    proposalId: input.proposalId,
    key: input.key,
    text: input.text,
    forWho: input.forWho,
    sourceMessageIds: [...input.sourceMessageIds],
    goalId: input.goalId ?? null,
    taskId: input.taskId ?? null,
    createdAt: ctx.now,
  };
  ctx.tx.insert(schema.shapeQuestions).values(row).run();
  return row;
}

export function listShapeQuestions(db: DbReader, shapeId: ShapeId): ShapeQuestionRow[] {
  return db
    .select()
    .from(schema.shapeQuestions)
    .where(eq(schema.shapeQuestions.shapeId, shapeId))
    .orderBy(asc(schema.shapeQuestions.id))
    .all();
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

/** The link naming a task Convert made, or undefined for a task no conversation made. */
export function findShapeLinkOfTask(db: DbReader, taskId: TaskId): ShapeLinkRow | undefined {
  return db.select().from(schema.shapeLinks).where(eq(schema.shapeLinks.taskId, taskId)).get();
}

/** Deletes the links of one proposal, when Remove Draft Goal makes it pending again. */
export function deleteShapeLinksOf(ctx: WriteContext, proposalId: ShapeProposalId): void {
  ctx.tx.delete(schema.shapeLinks).where(eq(schema.shapeLinks.proposalId, proposalId)).run();
}

/** Deletes a question Convert stored, and its link; its proposal is the caller's to reset. */
export function releaseShapeQuestion(ctx: WriteContext, questionId: ShapeQuestionId): void {
  ctx.tx.delete(schema.shapeLinks).where(eq(schema.shapeLinks.questionId, questionId)).run();
  ctx.tx.delete(schema.shapeQuestions).where(eq(schema.shapeQuestions.id, questionId)).run();
}

/**
 * Takes back the questions a task removal detached from the tasks of a goal Remove Draft Goal is
 * about to remove: each is deleted with its link and its proposal is pending again, so it converts
 * anew with the goal, as for a question still attached. A detached question has neither a goal nor a
 * task, so it is found by the key its proposal says it is about; `taskKeys` are the keys the goal's
 * tasks were converted under. Call it before those links go.
 */
export function releaseDetachedShapeQuestions(
  ctx: WriteContext,
  shapeId: ShapeId,
  taskKeys: readonly string[],
): void {
  if (taskKeys.length === 0) return;
  const detached = ctx.tx
    .select()
    .from(schema.shapeQuestions)
    .where(
      and(
        eq(schema.shapeQuestions.shapeId, shapeId),
        isNull(schema.shapeQuestions.goalId),
        isNull(schema.shapeQuestions.taskId),
      ),
    )
    .all();
  for (const question of detached) {
    const proposal = ctx.tx
      .select()
      .from(schema.shapeProposals)
      .where(eq(schema.shapeProposals.id, question.proposalId))
      .get();
    const about = ShapeProposalBody.question.safeParse(proposal?.body).data?.about;
    if (about === undefined || !taskKeys.includes(about)) continue;
    releaseShapeQuestion(ctx, question.id);
    patchShapeProposal(ctx, question.proposalId, {
      state: ShapeProposalState.Pending,
      acceptId: null,
    });
  }
}

/**
 * Gives a diagram, chart or mockup attached by goal or task id back to the proposal row it came from.
 * attach() keys such a row by the id of the goal or task, which Remove Draft Goal deletes, so each
 * row is keyed again by its link's key (the goal's or the task's proposal key) before the links go.
 * Pass the links of the goal and of every task in it, those added in a later round included, while
 * they still exist. A spec or eval is already keyed by its proposal.
 */
export function rekeyShapeAttachmentsToProposal(
  ctx: WriteContext,
  links: readonly Pick<ShapeLinkRow, 'shapeId' | 'key' | 'goalId' | 'taskId'>[],
): void {
  for (const link of links) {
    const id = link.goalId ?? link.taskId;
    if (id === null) continue;
    ctx.tx
      .update(schema.shapeAttachments)
      .set({ key: link.key, updatedAt: ctx.now })
      .where(
        and(eq(schema.shapeAttachments.shapeId, link.shapeId), eq(schema.shapeAttachments.key, id)),
      )
      .run();
  }
}

/**
 * Lets go of a goal and its tasks as they are removed (Shape spec §11). A question stored under any
 * of them is deleted with its link and its proposal is pending again, so it converts anew with the
 * goal; every other link to those tasks goes too, so no later Convert resolves a key to a removed task.
 * Attachments of the goal or its tasks are detached, not deleted: a spec or eval (keyed by its
 * proposal) and a diagram keyed again by rekeyShapeAttachmentsToProposal stay with the conversation,
 * attached to no goal or task, and Convert links them to the goal or task it makes anew.
 */
export function releaseShapeLinksOfGoal(
  ctx: WriteContext,
  goalId: GoalId,
  taskIds: readonly TaskId[],
): void {
  const questions = ctx.tx
    .select()
    .from(schema.shapeQuestions)
    .where(
      or(
        eq(schema.shapeQuestions.goalId, goalId),
        inArray(schema.shapeQuestions.taskId, [...taskIds]),
      ),
    )
    .all();
  for (const question of questions) {
    releaseShapeQuestion(ctx, question.id);
    patchShapeProposal(ctx, question.proposalId, {
      state: ShapeProposalState.Pending,
      acceptId: null,
    });
  }
  ctx.tx
    .delete(schema.shapeLinks)
    .where(inArray(schema.shapeLinks.taskId, [...taskIds]))
    .run();
  // Every attachment is now keyed by its proposal (see the doc above) and attached to no goal or
  // task; it must not hold the goal or task row it leaves.
  ctx.tx
    .update(schema.shapeAttachments)
    .set({ goalId: null, updatedAt: ctx.now })
    .where(eq(schema.shapeAttachments.goalId, goalId))
    .run();
  ctx.tx
    .update(schema.shapeAttachments)
    .set({ taskId: null, updatedAt: ctx.now })
    .where(inArray(schema.shapeAttachments.taskId, [...taskIds]))
    .run();
}
