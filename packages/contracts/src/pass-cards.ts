import { z } from 'zod';
import { PassId, TaskId, WorkstreamId } from './ids';
import { SharedAskDetail } from './pass-shared';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §5.3, §5.4, §7.2, §8.3,
// §8.4: the Inbox cards a pass raises. Each card's `detail` is one of these, told apart by `kind`, so
// the built `POST /inbox/:id/answer` dispatches on it.

/** D8: the folder stays on the pass's branch, because its return branch is in use or moved. */
export const PassBranchMovedDetail = z.object({
  kind: z.literal('pass_branch_moved'),
  passId: PassId,
  returnBranch: z.string(),
  passBranch: z.string(),
  reason: z.enum(['in_use_elsewhere', 'moved']),
  /** The command that merges the pass's branch into the return branch. */
  mergeCommand: z.string(),
});
export type PassBranchMovedDetail = z.infer<typeof PassBranchMovedDetail>;

/** Why the folder's branch was not realigned with the base by itself (D22). */
export const PassMoveReason = {
  /** The pass closed; its pull request has not merged yet. */
  Closed: 'closed',
  /** Another pull request reached the base first. */
  Drift: 'drift',
  /** A CI fix was pushed to the pull request. */
  CiFix: 'ci_fix',
  /** The pull request closed without merging. */
  ClosedUnmerged: 'closed_unmerged',
} as const;
export type PassMoveReason = (typeof PassMoveReason)[keyof typeof PassMoveReason];

/** D22's card: Move puts the folder on the base, where the pass's work is once merged. */
export const PassMoveDetail = z.object({
  kind: z.literal('pass_move'),
  passId: PassId,
  returnBranch: z.string(),
  base: z.string(),
  reason: z.enum(PassMoveReason),
  prUrl: z.string().nullable(),
});
export type PassMoveDetail = z.infer<typeof PassMoveDetail>;
export const PASS_MOVE_CHOICE = 'Move';

/** D24's card: the pass this one is stacked on closed unmerged; Retarget bases its pull request on `base`. */
export const PassRetargetDetail = z.object({
  kind: z.literal('pass_retarget'),
  passId: PassId,
  stackedOn: PassId,
  base: z.string(),
});
export type PassRetargetDetail = z.infer<typeof PassRetargetDetail>;
export const PASS_RETARGET_CHOICE = 'Retarget';

/** A close's gate failed: the pass is open again, and the next Close Pass retries. It has no Retry. */
export const PassGateFailedDetail = z.object({
  kind: z.literal('pass_gate_failed'),
  passId: PassId,
  where: z.enum(['scratch', 'folder']),
  logPath: z.string().nullable(),
  /** The pages whose files the failure names. */
  tasks: z.array(z.object({ taskId: TaskId, title: z.string() })),
});
export type PassGateFailedDetail = z.infer<typeof PassGateFailedDetail>;

/** §8.4: a pass task asked for a hazard (migrations, dependencies) that runs in a separate copy. */
export const PassMoveToCopyDetail = z.object({
  kind: z.literal('pass_move_to_copy'),
  passId: PassId,
  taskId: TaskId,
  workstreamId: WorkstreamId,
  hazard: z.string().min(1),
});
export type PassMoveToCopyDetail = z.infer<typeof PassMoveToCopyDetail>;
export const PASS_MOVE_TO_COPY_CHOICE = 'Move to a Separate Copy';
export const PASS_NOT_NOW_CHOICE = 'Not Now';

/** The pass's pull request merged while it was open: it closed, and its unfinished pages carry over. */
export const PassFollowOnDetail = z.object({
  kind: z.literal('pass_follow_on'),
  passId: PassId,
  /** The pass the unfinished pages carried over to; null when none was left. */
  followOnPassId: PassId.nullable(),
  /** A follow-on pull request for sign-offs after the last push; null when none was opened. */
  prUrl: z.string().nullable(),
  carried: z.array(TaskId),
});
export type PassFollowOnDetail = z.infer<typeof PassFollowOnDetail>;

/** The detail of any card a pass raises, by `kind`. */
export const PassCardDetail = z.discriminatedUnion('kind', [
  SharedAskDetail,
  PassBranchMovedDetail,
  PassMoveDetail,
  PassRetargetDetail,
  PassGateFailedDetail,
  PassMoveToCopyDetail,
  PassFollowOnDetail,
]);
export type PassCardDetail = z.infer<typeof PassCardDetail>;
