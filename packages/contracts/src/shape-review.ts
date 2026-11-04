import { z } from 'zod';
import { ShapeFindingId, ShapeId, ShapeProposalId } from './ids';
import {
  Ceremony,
  ShapeFindingKind,
  ShapeFindingSeverity,
  ShapeFindingState,
  ShapeReviewer,
} from './shape';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §7. What the screen
// reads of ceremony, reviewers' findings and the implementer rehearsal, and the project's one-way paths.

const Timestamp = z.iso.datetime();

/**
 * A reviewer's finding, or a question the rehearsal's implementer would have to ask. `effortKey` is the
 * goal's or loose task's key; `taskKey` names the task a rehearsal read, and a finding under one task.
 */
export const ShapeFindingDto = z.object({
  id: ShapeFindingId,
  shapeId: ShapeId,
  effortKey: z.string(),
  taskKey: z.string().nullable(),
  reviewer: z.enum(ShapeReviewer),
  kind: z.enum(ShapeFindingKind),
  /** A question has none. */
  severity: z.enum(ShapeFindingSeverity).nullable(),
  text: z.string(),
  state: z.enum(ShapeFindingState),
  /** The one-line how, once resolved or dismissed. */
  how: z.string().nullable(),
  /** The round the effort was in when it was reported. */
  round: z.int().min(0),
  /** The hash of the task the reviewer read, stamped by the daemon; null for an effort-level finding. */
  taskHash: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ShapeFindingDto = z.infer<typeof ShapeFindingDto>;

/** Why an effort is forced to `spec` (§7). */
export const CeremonyReason = {
  LooseL: 'loose_l',
  GoalXl: 'goal_xl',
  ManyTasks: 'many_tasks',
  OneWayPath: 'one_way_path',
} as const;
export type CeremonyReason = (typeof CeremonyReason)[keyof typeof CeremonyReason];

/**
 * One effort's ceremony: what the rule forces, and what applies. The builder pins a forced effort to
 * `direct` by editing its `ceremony`; it then reads "spec skipped by you".
 */
export const ShapeCeremonyDto = z.object({
  proposalId: ShapeProposalId,
  /** The goal's or loose task's key. */
  key: z.string(),
  /** What applies: `spec` when forced (unless the builder pinned `direct`) or when Claude chose it. */
  ceremony: z.enum(Ceremony),
  /** What forces it, in plain words, in the order the rule lists them; empty when nothing does. */
  reasons: z.array(z.enum(CeremonyReason)),
  /** Forced to `spec`, and the builder pinned `direct`. */
  skippedByYou: z.boolean(),
  /** The session has written the effort's spec. */
  specWritten: z.boolean(),
  /** The spec, when written. */
  spec: z.string().nullable(),
});
export type ShapeCeremonyDto = z.infer<typeof ShapeCeremonyDto>;

/** Whether one proposed task has been read by the rehearsal at the content it has now. */
export const ShapeRehearsalDto = z.object({
  proposalId: ShapeProposalId,
  /** The task's key: the proposal's own for a loose task, the goal task's inside a goal. */
  key: z.string(),
  /** The task's content hash now. */
  hash: z.string(),
  /** A mark exists for this hash: the rehearsal read it and reported (zero questions included). */
  rehearsed: z.boolean(),
});
export type ShapeRehearsalDto = z.infer<typeof ShapeRehearsalDto>;

/** `POST /shapes/:id/rehearse`: which proposals to rehearse; absent, every pending one. */
export const ShapeRehearseInput = z.object({
  proposalIds: z.array(ShapeProposalId).min(1).optional(),
});
export type ShapeRehearseInput = z.infer<typeof ShapeRehearseInput>;

/** `started`: a rehearsal turn is queued; `running`: one already is; `nothing`: every task has its mark. */
export const ShapeRehearseResult = z.object({
  status: z.enum(['started', 'running', 'nothing']),
  /** How many tasks the turn was told to read. */
  tasks: z.int().min(0),
});
export type ShapeRehearseResult = z.infer<typeof ShapeRehearseResult>;

/** Dismiss a finding, with a one-line reason. */
export const ShapeDismissInput = z.object({ how: z.string().min(1).max(200).optional() });
export type ShapeDismissInput = z.infer<typeof ShapeDismissInput>;

/** Settings › General: globs of the paths a mistake in is hard to undo (§7); a task in one needs a spec. */
export const OneWayPathsDto = z.object({ paths: z.array(z.string().min(1).max(200)).max(64) });
export type OneWayPathsDto = z.infer<typeof OneWayPathsDto>;

/**
 * The size of a lane's proposal, title and body in characters, up to which 10db files a new task to
 * the Icebox by itself when it carries no risk tag. Settings › General; zero sends every proposal to
 * the Inbox.
 */
export const DEFAULT_SMALL_PROPOSAL_LIMIT = 1200;
export const MAX_SMALL_PROPOSAL_LIMIT = 20_000;
export const SmallProposalLimitDto = z.object({
  limit: z.int().min(0).max(MAX_SMALL_PROPOSAL_LIMIT),
});
export type SmallProposalLimitDto = z.infer<typeof SmallProposalLimitDto>;

/** The goals spec's one-way class paths for 10db itself, used for a project that has them and sets none. */
export const DEFAULT_ONE_WAY_PATHS = [
  'packages/db/src/schema.ts',
  'packages/db/drizzle/**',
  'packages/contracts/src/**',
] as const;
