import { z } from 'zod';
import { PassId, TaskId, WorkstreamId } from './ids';
import { SharedAskDetail } from './pass-shared';
import { PageRoute } from './task-screens';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §5.3, §5.4, §7.2, §8.3,
// §8.4: the Inbox cards a pass raises. Each card's `detail` is one of these, told apart by `kind`, so
// the built `POST /inbox/:id/answer` dispatches on it.

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

/**
 * §8.4: a pass task asked for a hazard (migrations, dependencies) that runs in a separate copy, or broke
 * the preview of its route on two turns running; exactly one of `hazard` and `route` names why. A card
 * stored before a broken preview could raise one has no `route`.
 */
export const PassMoveToCopyDetail = z
  .object({
    kind: z.literal('pass_move_to_copy'),
    passId: PassId,
    taskId: TaskId,
    workstreamId: WorkstreamId,
    hazard: z.string().min(1).nullable(),
    route: PageRoute.nullable().default(null),
  })
  .refine((d) => (d.hazard === null) !== (d.route === null), {
    message: 'A Move card names a hazard or a broken route, exactly one',
    path: ['route'],
  });
export type PassMoveToCopyDetail = z.infer<typeof PassMoveToCopyDetail>;
export const PASS_MOVE_TO_COPY_CHOICE = 'Move to a Separate Copy';
export const PASS_NOT_NOW_CHOICE = 'Not Now';

/** The detail of any card a pass raises, by `kind`. */
export const PassCardDetail = z.discriminatedUnion('kind', [
  SharedAskDetail,
  PassMoveDetail,
  PassRetargetDetail,
  PassMoveToCopyDetail,
]);
export type PassCardDetail = z.infer<typeof PassCardDetail>;
