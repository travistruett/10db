import { z } from 'zod';
import { BatchId, PassId, ProjectId } from './ids';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §5, §11. A pass is the
// builder working through pages with the agents, live in Your folder, on a branch of its own.

const Timestamp = z.iso.datetime();

/**
 * Where a pass is. `CLOSED` means shipped and fast-forwarded; `SETTLED` means its work is in the base
 * or the builder moved the branch; a `local` project's pass goes straight to `SETTLED`.
 */
export const PassState = {
  Open: 'OPEN',
  Closing: 'CLOSING',
  Closed: 'CLOSED',
  Settled: 'SETTLED',
  Abandoning: 'ABANDONING',
  Abandoned: 'ABANDONED',
} as const;
export type PassState = (typeof PassState)[keyof typeof PassState];

/** A project has at most one pass in these states; the database's partial unique index lists the same three. */
export const OPEN_PASS_STATES: readonly PassState[] = [
  PassState.Open,
  PassState.Closing,
  PassState.Abandoning,
];

/**
 * Whether a pass still holds its tasks as pass tasks: while it is open, closing or abandoning. Its
 * close signs off or takes out every task before the pass is closed, and its Abandon takes out every
 * unsigned one, so a closed, settled or abandoned pass holds none: a task of one is ordinary work
 * again, whatever its `pass_id` still says.
 */
export function passHoldsTasks(state: PassState): boolean {
  return OPEN_PASS_STATES.includes(state);
}

/**
 * Whether a pass still holds Your folder (W9): until its work is in the base or it is abandoned, an
 * ordinary task that would run in the folder runs in a separate copy or waits.
 */
export function passHoldsFolder(state: PassState): boolean {
  return state !== PassState.Settled && state !== PassState.Abandoned;
}

/** How many pages a pass holds, and so how many of its lanes run, unless the builder says otherwise (W11). */
export const PASS_PAGE_CAP_DEFAULT = 4;
export const PASS_PAGE_CAP_MAX = 6;
export const PassPageCap = z.int().min(1).max(PASS_PAGE_CAP_MAX);

/** The line an ordinary task in Your folder shows while a pass holds the folder. */
export const PASS_FOLDER_WAIT_NOTICE_KEY = 'workbench-pass';
export const PASS_FOLDER_WAIT_LINE = 'Waits for the Workbench pass to close';

export const PassDto = z.object({
  id: PassId,
  projectId: ProjectId,
  name: z.string(),
  state: z.enum(PassState),
  /** The pass's one batch; it carries the branch, the base commit and the pull request. */
  batchId: BatchId,
  pageCap: PassPageCap,
  /** The branch HEAD named when the pass opened, where its close returns the folder. */
  returnBranch: z.string(),
  /** The commit HEAD was at when the pass opened; its branch starts here. */
  startSha: z.string(),
  openedAt: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type PassDto = z.infer<typeof PassDto>;

/**
 * One path of the folder that differed from the pass's start when it opened, with the hash of its
 * content on disk; `blob` is null for a file deleted from the folder.
 */
export const PassDirtEntry = z.object({
  path: z.string().min(1),
  blob: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)
    .nullable(),
});
export type PassDirtEntry = z.infer<typeof PassDirtEntry>;
