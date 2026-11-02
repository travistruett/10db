import { z } from 'zod';
import { DecisionId, GoalId, ShapeProposalId, TaskId } from './ids';
import {
  ShapeDto,
  ShapeMessageDto,
  ShapeProposalBody,
  ShapeProposalKind,
  ShapeProposalState,
} from './shape';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §4, §6 Rows, §11.
// What the Shape routes answer and accept: the view the screen renders, and the builder's actions.

const Timestamp = z.iso.datetime();

/** What Convert made from a proposal; a goal lists its tasks, a loose task is one, a decision has its own id. */
export const ShapeConvertedDto = z.object({
  goalId: GoalId.nullable(),
  taskIds: z.array(TaskId),
  decisionId: DecisionId.nullable(),
  /** The converted decision was withdrawn (Withdraw Decision…); absent for every other kind. */
  withdrawn: z.boolean().optional(),
});
export type ShapeConvertedDto = z.infer<typeof ShapeConvertedDto>;

const proposalFields = {
  id: ShapeProposalId,
  key: z.string(),
  state: z.enum(ShapeProposalState),
  /** The round that last created or changed it. */
  round: z.int().min(0),
  /** The fields the builder pinned; empty until slice 2's editing. */
  pinned: z.array(z.string()),
  /** What it became once accepted; null while it is pending, superseded or rejected. */
  converted: ShapeConvertedDto.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
};

/** A proposal row with its typed body, discriminated by kind (the body is parsed with its kind's schema). */
export const ShapeProposalDto = z.discriminatedUnion('kind', [
  z.object({
    ...proposalFields,
    kind: z.literal(ShapeProposalKind.Goal),
    body: ShapeProposalBody.goal,
  }),
  z.object({
    ...proposalFields,
    kind: z.literal(ShapeProposalKind.Task),
    body: ShapeProposalBody.task,
  }),
  z.object({
    ...proposalFields,
    kind: z.literal(ShapeProposalKind.ChangeTask),
    body: ShapeProposalBody.change_task,
  }),
  z.object({
    ...proposalFields,
    kind: z.literal(ShapeProposalKind.RemoveTask),
    body: ShapeProposalBody.remove_task,
  }),
  z.object({
    ...proposalFields,
    kind: z.literal(ShapeProposalKind.Decision),
    body: ShapeProposalBody.decision,
  }),
  z.object({
    ...proposalFields,
    kind: z.literal(ShapeProposalKind.Principle),
    body: ShapeProposalBody.principle,
  }),
  z.object({
    ...proposalFields,
    kind: z.literal(ShapeProposalKind.Question),
    body: ShapeProposalBody.question,
  }),
  z.object({
    ...proposalFields,
    kind: z.literal(ShapeProposalKind.Landing),
    body: ShapeProposalBody.landing,
  }),
]);
export type ShapeProposalDto = z.infer<typeof ShapeProposalDto>;

/** Where a conversation's session is: answering now, with how many turns waiting behind it. */
export const ShapeTurnDto = z.object({
  running: z.boolean(),
  queued: z.int().min(0),
  /** A Propose turn is queued or running; pressing Propose again would be ignored. */
  proposing: z.boolean(),
});
export type ShapeTurnDto = z.infer<typeof ShapeTurnDto>;

/** Everything the Shape screen renders for one conversation. */
export const ShapeViewDto = z.object({
  shape: ShapeDto,
  /** The transcript, oldest first. */
  messages: z.array(ShapeMessageDto),
  /** Every proposal row, tombstones and superseded ones included, in the order they were made. */
  proposals: z.array(ShapeProposalDto),
  /** The latest `note_heard` echo, shown before the first Propose. */
  heard: z.array(z.string()),
  turn: ShapeTurnDto,
});
export type ShapeViewDto = z.infer<typeof ShapeViewDto>;

/** Opens a conversation; the title is replaced by the first message's opening words. */
export const ShapeInput = z.object({ title: z.string().min(1).max(200).optional() });
export type ShapeInput = z.infer<typeof ShapeInput>;

export const SHAPE_MESSAGE_MAX_CHARS = 20_000;

export const ShapeMessageInput = z.object({ text: z.string().min(1).max(SHAPE_MESSAGE_MAX_CHARS) });
export type ShapeMessageInput = z.infer<typeof ShapeMessageInput>;

export const ShapeProposeResult = z.object({ status: z.enum(['started', 'ignored']) });
export type ShapeProposeResult = z.infer<typeof ShapeProposeResult>;

export const ShapeConvertInput = z.object({
  proposalIds: z.array(ShapeProposalId).min(1),
  /** Stops the turn that is running instead of answering 409. */
  interrupt: z.boolean().optional(),
});
export type ShapeConvertInput = z.infer<typeof ShapeConvertInput>;

/** What one converted proposal became, as Convert answers. */
export const ShapeConvertedRow = z.object({
  key: z.string(),
  kind: z.enum(ShapeProposalKind),
  goalId: GoalId.optional(),
  taskIds: z.array(TaskId),
  decisionId: DecisionId.optional(),
});
export type ShapeConvertedRow = z.infer<typeof ShapeConvertedRow>;

export const ShapeConvertResult = z.object({
  /** How many proposals this call converted; a repeated Convert reports 0. */
  createdNow: z.int().min(0),
  results: z.array(ShapeConvertedRow),
});
export type ShapeConvertResult = z.infer<typeof ShapeConvertResult>;

/** The 400 body of Convert when it refuses: every error at once, nothing written. */
export const ShapeConvertError = z.object({ errors: z.array(z.string().min(1)).min(1) });
export type ShapeConvertError = z.infer<typeof ShapeConvertError>;

/** Withdraw Decision…: the builder's reason is required. */
export const ShapeWithdrawInput = z.object({ reason: z.string().min(1).max(2000) });
export type ShapeWithdrawInput = z.infer<typeof ShapeWithdrawInput>;
