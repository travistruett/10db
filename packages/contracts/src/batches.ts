import { z } from 'zod';
import { ProjectDto, WorkstreamDto } from './entities';
import { BatchId, ProjectId, TaskId } from './ids';
import { BatchFailure, BatchState } from './states';

const Timestamp = z.iso.datetime();

/** One batch: one branch and one pull request (batch delivery spec §3). */
export const BatchDto = z.object({
  id: BatchId,
  projectId: ProjectId,
  title: z.string(),
  state: z.enum(BatchState),
  /** Null until the branch is cut. */
  branch: z.string().nullable(),
  baseBranch: z.string(),
  /** The commit the branch was cut from; null until it is cut. */
  baseSha: z.string().nullable(),
  /** The GitHub `owner/name`, recorded when the branch is cut. */
  repo: z.string().nullable(),
  prUrl: z.string().nullable(),
  gateExitCode: z.int().nullable(),
  gateLogPath: z.string().nullable(),
  failure: z.enum(BatchFailure).nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type BatchDto = z.infer<typeof BatchDto>;

/** `POST /projects/:projectId/batches`. M2b's batch approval sends this; keep it stable. */
export const BatchStartInput = z
  .object({
    title: z.string().min(1).max(200),
    taskIds: z.array(TaskId).min(1).max(50),
  })
  .refine((i) => new Set(i.taskIds).size === i.taskIds.length, {
    message: 'Name each task once',
    path: ['taskIds'],
  });
export type BatchStartInput = z.infer<typeof BatchStartInput>;

/**
 * `GET /projects`: each project with its unfinished batch, else its latest one. A body without the
 * field reads as no batch, so a client that only knows ProjectDto-shaped answers still parses.
 */
export const ProjectViewDto = ProjectDto.extend({
  currentBatch: BatchDto.nullable().default(null),
});
export type ProjectViewDto = z.infer<typeof ProjectViewDto>;

/** `POST /tasks/:taskId/start`: the workstream in local delivery, the batch it runs in for pull requests. */
export const TaskStartResult = z.union([WorkstreamDto, BatchDto]);
export type TaskStartResult = z.infer<typeof TaskStartResult>;
