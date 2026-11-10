import { z } from 'zod';
import { GitObjectName } from './git-names';
import { ClaimId, PassId, TaskId, WorkstreamId } from './ids';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §7.2, §11: a pass task's
// hold on a shared area for one turn, the shared changes those holds keep on the pass's chain, and the
// question asked before a second task of the pass changes a shared area.

const Timestamp = z.iso.datetime();

/** A shared change's number on the pass's chain, given at its hold's grant; the chain starts at 1. */
export const SharedSeq = z.int().min(1);

/**
 * One path of a hold's record or of a shared change: the hash of its content, or null for a file
 * that is deleted.
 */
export const SharedPathBlob = z.object({
  path: z.string().min(1),
  blob: GitObjectName.nullable(),
});
export type SharedPathBlob = z.infer<typeof SharedPathBlob>;

/**
 * A pass task's hold on a shared area for one turn (spec §7.2): the claim it was granted as, its
 * number on the chain, and the commit holding the content of the paths that differed at the grant.
 * `closedAt` is set when the turn's end kept it; `empty` then says it changed nothing.
 */
export const PassHoldDto = z.object({
  claimId: ClaimId,
  passId: PassId,
  taskId: TaskId,
  workstreamId: WorkstreamId,
  area: z.string().min(1),
  seq: SharedSeq,
  /** The unsigned commit at `refs/10db/passes/<pass id>/holds/<claim id>` that holds the record's content. */
  recordSha: GitObjectName,
  grantedAt: Timestamp,
  closedAt: Timestamp.nullable(),
  empty: z.boolean(),
});
export type PassHoldDto = z.infer<typeof PassHoldDto>;

/**
 * One commit of the pass's shared chain (spec §7.2), numbered as its hold was. A drop is a row of its
 * own that names the change it puts back (`dropOf`), and the dropped change names it (`droppedBy`).
 */
export const PassSharedChangeDto = z.object({
  passId: PassId,
  seq: SharedSeq,
  taskId: TaskId,
  /** The chain commit that keeps the change. */
  sha: GitObjectName,
  /** The paths the change sets, sorted. */
  paths: z.array(z.string().min(1)),
  /** The content each path is set to, by path; null for a file the change deletes. */
  blobs: z.record(z.string(), GitObjectName.nullable()),
  /** Whether a file that was already dirty at the grant was kept whole with the agent's edits. */
  dirtyKept: z.boolean(),
  /** The commit on the pass's branch that landed the change; null until it lands. */
  landedSha: GitObjectName.nullable(),
  droppedBy: SharedSeq.nullable(),
  dropOf: SharedSeq.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type PassSharedChangeDto = z.infer<typeof PassSharedChangeDto>;

/** The options of the question asked before a task changes a shared area another task changed (W5). */
export const SHARED_ASK_ALLOW_CHOICE = 'Allow';
export const SHARED_ASK_KEEP_CHOICE = 'Keep It to This Page';
/** The builder's own words go to the agent as the answer, with the note. */
export const SHARED_ASK_REPLY_CHOICE = 'Reply';

/** The question's fold key: one open question per workstream and area. */
export function sharedAskFoldKey(workstreamId: WorkstreamId, area: string): string {
  return `shared-ask:${workstreamId}:${area}`;
}

/**
 * The detail of the shared question (spec §7.2 step 3): the task asking for the area, and each other
 * task of the pass that changed the area during the pass or holds it now.
 */
export const SharedAskDetail = z.object({
  kind: z.literal('shared_ask'),
  passId: PassId,
  taskId: TaskId,
  workstreamId: WorkstreamId,
  area: z.string().min(1),
  others: z.array(
    z.object({
      taskId: TaskId,
      title: z.string(),
      /** The shared files it changed; empty while it holds the area and has kept nothing. */
      paths: z.array(z.string()),
      /** When it last changed the area, or null while it only holds it. */
      at: Timestamp.nullable(),
      holdsNow: z.boolean(),
    }),
  ),
});
export type SharedAskDetail = z.infer<typeof SharedAskDetail>;
