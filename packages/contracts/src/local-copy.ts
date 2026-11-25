import { z } from 'zod';
import { BatchId } from './ids';

/** A git object id: 40 hex digits (SHA-1) or 64 (SHA-256); it reaches git's argv. */
const ObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const Timestamp = z.iso.datetime();

/** Where a separate copy's landing stands; the journal row writes each step before it acts. */
export const CopyStep = {
  Open: 'open',
  Merging: 'merging',
  Gating: 'gating',
  Gated: 'gated',
  Promoting: 'promoting',
  Landed: 'landed',
  Retiring: 'retiring',
  Retired: 'retired',
} as const;
export type CopyStep = (typeof CopyStep)[keyof typeof CopyStep];

/** Why a landing is paused until the builder's folder or the base changes. */
export const CopyWait = {
  FolderOffBase: 'folder_off_base',
  EditsInTheWay: 'edits_in_the_way',
  IndexLocked: 'index_locked',
  BaseMoving: 'base_moving',
} as const;
export type CopyWait = (typeof CopyWait)[keyof typeof CopyWait];

/** The first 12 hex digits of the SHA-256 of a copy batch's id: safe inside a database name. */
export const CopyId = z
  .string()
  .regex(/^[0-9a-f]{12}$/)
  .brand<'CopyId'>();
export type CopyId = z.infer<typeof CopyId>;

/** Names the separate copy whose databases a command may reach; each copy's command gets its own. */
export const COPY_ID_VARIABLE = 'TENDB_COPY_ID';

/** One copy batch's journal row. A batch is a local copy exactly when it has one. */
export const LocalCopyDto = z.object({
  batchId: BatchId,
  copyId: CopyId,
  step: z.enum(CopyStep),
  /** T, the base tip the step expects. */
  baseTip: ObjectId.nullable(),
  /** C, the commit that lands. */
  candidate: ObjectId.nullable(),
  /** Races with the base so far. */
  attempt: z.number().int(),
  wait: z.enum(CopyWait).nullable(),
  /** The paths or branch the wait's card names. */
  waitDetail: z.array(z.string()).readonly(),
  /** When a timed wait checks again. */
  retryAt: Timestamp.nullable(),
  /** The teardown command, pinned at the cut. */
  teardownCommand: z.string(),
  /** The commit the teardown runs from, set when the batch opens. */
  teardownSha: ObjectId.nullable(),
  updatedAt: Timestamp,
});
export type LocalCopyDto = z.infer<typeof LocalCopyDto>;

/** Why a task whose process runs no review can't work in a separate copy. */
export const COPY_NEEDS_REVIEW =
  "A separate copy lands only after a review, and this task's process runs none: raise its rigor first";
