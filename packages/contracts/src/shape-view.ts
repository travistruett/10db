import { z } from 'zod';
import {
  DecisionId,
  GoalId,
  PrincipleId,
  ShapeAttachmentId,
  ShapeId,
  ShapeMessageId,
  ShapeProposalId,
  ShapeQuestionId,
  TaskId,
} from './ids';
import {
  ShapeAttachment,
  ShapeDto,
  ShapeMessageDto,
  ShapeProposalBody,
  ShapeProposalKind,
  ShapeProposalState,
} from './shape';
import { ShapeFileDto } from './shape-files';
import { ShapeTaskSizeDto } from './shape-measures';
import { ShapePreviewDto } from './shape-preview';
import { ShapeCeremonyDto, ShapeFindingDto, ShapeRehearsalDto } from './shape-review';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §4, §6 Rows, §11.
// What the Shape routes answer and accept: the view the screen renders, and the builder's actions.

const Timestamp = z.iso.datetime();

/** What the latest round did to a row (§6 What changed, and why). */
export const ShapeRoundMark = { New: 'new', Changed: 'changed', Moved: 'moved' } as const;
export type ShapeRoundMark = (typeof ShapeRoundMark)[keyof typeof ShapeRoundMark];

/** What Convert made from a proposal; a goal lists its tasks, a loose task is one, a decision has its own id. */
export const ShapeConvertedDto = z.object({
  goalId: GoalId.nullable(),
  taskIds: z.array(TaskId),
  decisionId: DecisionId.nullable(),
  /** The principle Convert wrote; absent for every other kind. */
  principleId: PrincipleId.nullable().optional(),
  /** The question Convert stored; absent for every other kind. */
  questionId: ShapeQuestionId.nullable().optional(),
  /** The converted decision or principle was withdrawn (Withdraw Decision…, Withdraw Principle…); absent for every other kind. */
  withdrawn: z.boolean().optional(),
  /** The converted principle was replaced by a later one with its topic key and scope; absent for every other kind. */
  superseded: z.boolean().optional(),
  /** The converted principle was retired from the Knowledge view; absent for every other kind. */
  retired: z.boolean().optional(),
});
export type ShapeConvertedDto = z.infer<typeof ShapeConvertedDto>;

const proposalFields = {
  id: ShapeProposalId,
  key: z.string(),
  state: z.enum(ShapeProposalState),
  /** The round that last created or changed it. */
  round: z.int().min(0),
  /** The fields the builder pinned; `*` pins the row as a whole (Restore). */
  pinned: z.array(z.string()),
  /**
   * What the latest round did to it, until the next round (§6): created it, changed it, or moved it to
   * Earlier. Null for a row the latest round left alone.
   */
  mark: z.enum(ShapeRoundMark).nullable(),
  /** The builder's messages it came from; what Why? scrolls to and highlights. Empty for a builder's own row. */
  sourceMessageIds: z.array(ShapeMessageId),
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
  /** A rehearsal turn is queued or running (§7): the Convert modal says "Rehearsing n tasks…". */
  rehearsing: z.boolean(),
});
export type ShapeTurnDto = z.infer<typeof ShapeTurnDto>;

/**
 * A diagram, chart or mockup the session attached (§10.3): to a proposal by `key`, or to a goal or task
 * the conversation converted (its id, and `key` holds the same id). The screen renders each inert.
 */
export const ShapeAttachmentDto = z.object({
  id: ShapeAttachmentId,
  key: z.string(),
  goalId: GoalId.nullable(),
  taskId: TaskId.nullable(),
  attachment: ShapeAttachment,
});
export type ShapeAttachmentDto = z.infer<typeof ShapeAttachmentDto>;

/** Everything the Shape screen renders for one conversation. */
export const ShapeViewDto = z.object({
  shape: ShapeDto,
  /** The transcript, oldest first. */
  messages: z.array(ShapeMessageDto),
  /** Every proposal row, tombstones and superseded ones included, in the order they were made. */
  proposals: z.array(ShapeProposalDto),
  /** The latest `note_heard` echo, shown before the first Propose. */
  heard: z.array(z.string()),
  /** The files dropped into the conversation, oldest first (§5.4). */
  files: z.array(ShapeFileDto),
  turn: ShapeTurnDto,
  /** Each proposed task's derived size and hours, and its actual once converted and finished (§8). */
  sizes: z.array(ShapeTaskSizeDto),
  /** Each pending effort's ceremony: what the rule forces and what applies (§7). */
  ceremony: z.array(ShapeCeremonyDto),
  /** Reviewers' findings and the rehearsal's questions, oldest first, resolved and dismissed included. */
  findings: z.array(ShapeFindingDto),
  /** Whether each pending task has been rehearsed at the content it has now (§7). */
  rehearsals: z.array(ShapeRehearsalDto),
  /** How the project's lanes would run the pending tasks, with the work already there holding lanes first (§10.2). */
  preview: ShapePreviewDto,
  /** The diagrams, charts and mockups attached so far, oldest first; specs and evals are not here. */
  attachments: z.array(ShapeAttachmentDto),
  /** The tokens (input and output) the conversation's sessions have used so far; the header says "88k tokens" (§4). */
  tokens: z.int().min(0),
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
  principleId: PrincipleId.optional(),
  questionId: ShapeQuestionId.optional(),
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

/** What the builder cannot set by editing a row: its identity and where it came from. */
const NOT_EDITABLE = new Set(['key', 'kind', 'goalId', 'sourceMessageIds']);

/**
 * Editing a row sets fields, and each is pinned (§6 Editing). A goal's task field is named by its
 * path, `tasks.<key>.<field>`, so a pin on one task never holds its siblings.
 */
export const ShapeEditInput = z.object({
  fields: z
    .record(z.string().min(1), z.unknown())
    .refine((fields) => Object.keys(fields).length > 0, { message: 'Set at least one field' })
    .refine((fields) => Object.keys(fields).every((f) => !NOT_EDITABLE.has(f)), {
      message: 'A row’s key, kind, goal and sources cannot be edited',
    }),
});
export type ShapeEditInput = z.infer<typeof ShapeEditInput>;

/** Unpin one field, or with none the whole row (a restored row is pinned as a whole). */
export const ShapeUnpinInput = z.object({ field: z.string().min(1).optional() });
export type ShapeUnpinInput = z.infer<typeof ShapeUnpinInput>;

/**
 * Reopens a conversation with an event injected as a note (§12). The event is what happened, in a
 * sentence: the engine's cards (an exhausted task, Flip) word it when they offer Re-plan in Shape.
 */
export const ShapeResumeInput = z.object({ event: z.string().min(1).max(2000) });
export type ShapeResumeInput = z.infer<typeof ShapeResumeInput>;

/** The conversation that made a goal or a task, for its drawer's Open conversation; null when none did. */
export const ShapeOfDto = z.object({ shapeId: ShapeId.nullable() });
export type ShapeOfDto = z.infer<typeof ShapeOfDto>;

/** Withdraw Decision…: the builder's reason is required. */
export const ShapeWithdrawInput = z.object({ reason: z.string().min(1).max(2000) });
export type ShapeWithdrawInput = z.infer<typeof ShapeWithdrawInput>;
