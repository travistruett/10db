import { z } from 'zod';
import { ProjectDto, Title, WorkstreamDto } from './entities';
import { BatchId, ProjectId, TaskId } from './ids';
import {
  BatchFailure,
  BatchState,
  CiStopped,
  PullRequestChecks,
  PullRequestMergeBlocked,
  PullRequestState,
  RequiredChecksState,
} from './states';

const Timestamp = z.iso.datetime();

/** One failing check of a pull request; `url` is null when GitHub gave none or not an https one. */
export const FailingCheckDto = z.object({
  name: z.string(),
  url: z.string().nullable(),
});
export type FailingCheckDto = z.infer<typeof FailingCheckDto>;

/** What the daemon last read of a shipped batch's pull request. */
export const PullRequestStatusDto = z.object({
  state: z.enum(PullRequestState),
  /**
   * While `state` is `unknown`, the checks (and `failingChecks`) gh last reported; `unknown` if it
   * never did. With a known `state`, `unknown` means GitHub listed a check 10db can't read and no
   * other check failed or is still running.
   */
  checks: z.enum(PullRequestChecks),
  failingChecks: z.array(FailingCheckDto),
  checkedAt: Timestamp,
  /** Why the state is `unknown`; null otherwise. */
  unknownReason: z.string().nullable(),
});
export type PullRequestStatusDto = z.infer<typeof PullRequestStatusDto>;

/**
 * One required check that is failing or pending. `jobId` and `runId` come from an Actions job link
 * and are null for a check with no Actions job.
 */
export const RequiredCheckJobDto = z.object({
  name: z.string(),
  link: z.string().nullable(),
  jobId: z.string().nullable(),
  runId: z.string().nullable(),
  description: z.string().nullable(),
});
export type RequiredCheckJobDto = z.infer<typeof RequiredCheckJobDto>;

/** What the watch last read of a pull request's required checks (CI-decides spec §4). */
export const RequiredChecksDto = z.object({
  state: z.enum(RequiredChecksState),
  failing: z.array(RequiredCheckJobDto),
  pending: z.array(RequiredCheckJobDto),
});
export type RequiredChecksDto = z.infer<typeof RequiredChecksDto>;

/** One batch: one branch and one pull request (batch delivery spec §3). */
export const BatchDto = z.object({
  id: BatchId,
  projectId: ProjectId,
  title: z.string(),
  state: z.enum(BatchState),
  /** Null until the branch is cut. */
  branch: z.string().nullable(),
  /** The branch it is cut from and its pull request targets: the project's, or the one its tasks named. */
  baseBranch: z.string(),
  /** True when the pull request merges by itself once its required checks pass. */
  autoMerge: z.boolean(),
  /** The commit the branch was cut from; null until it is cut. */
  baseSha: z.string().nullable(),
  /** The GitHub `owner/name`, recorded when the branch is cut. */
  repo: z.string().nullable(),
  prUrl: z.string().nullable(),
  /** The pull request's last read state; null until the daemon has read it (or there is no pull request). */
  pr: PullRequestStatusDto.nullable().default(null),
  /** The pull request's required checks as last read; null until read. Kept on the root batch. */
  prRequired: RequiredChecksDto.nullable().default(null),
  /** Why GitHub will not merge the pull request as it is; null when nothing blocks it. */
  prMergeBlocked: z.enum(PullRequestMergeBlocked).nullable().default(null),
  /** For a CI fix batch: the root batch whose pull request it fixes; null for any other batch. */
  ciFixOf: BatchId.nullable().default(null),
  /** For a CI fix batch: the pull request head whose failing checks it fixes. */
  ciFixHead: z.string().nullable().default(null),
  /** Why 10db stopped fixing the pull request's failing checks; null while it has not. */
  ciStopped: z.enum(CiStopped).nullable().default(null),
  gateExitCode: z.int().nullable(),
  gateLogPath: z.string().nullable(),
  failure: z.enum(BatchFailure).nullable(),
  /** The real path of the batch's worktree; null in shared mode and once the worktree is removed. */
  worktreePath: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type BatchDto = z.infer<typeof BatchDto>;

/** `POST /projects/:projectId/batches`. M2b's batch approval sends this; keep it stable. */
export const BatchStartInput = z
  .object({
    title: Title,
    taskIds: z.array(TaskId).min(1).max(50),
    /** Adds the tasks to this open or failed batch instead of starting new ones. */
    batchId: BatchId.optional(),
  })
  .refine((i) => new Set(i.taskIds).size === i.taskIds.length, {
    message: 'Name each task once',
    path: ['taskIds'],
  });
export type BatchStartInput = z.infer<typeof BatchStartInput>;

/** `POST /projects/:projectId/batches` answers 202 with the batches the start made or joined. */
export const BatchStartResult = z.array(BatchDto);
export type BatchStartResult = z.infer<typeof BatchStartResult>;

/**
 * `GET /projects`: each project with its unfinished batch, else its latest one. A body without the
 * field reads as no batch, so a client that only knows ProjectDto-shaped answers still parses.
 */
export const ProjectViewDto = ProjectDto.extend({
  currentBatch: BatchDto.nullable().default(null),
  /** Every unfinished batch, newest first; a worktree project has one per started task. */
  openBatches: z.array(BatchDto).default([]),
});
export type ProjectViewDto = z.infer<typeof ProjectViewDto>;

/** `POST /tasks/:taskId/start`: the workstream in local delivery, the batch it runs in for pull requests. */
export const TaskStartResult = z.union([WorkstreamDto, BatchDto]);
export type TaskStartResult = z.infer<typeof TaskStartResult>;
