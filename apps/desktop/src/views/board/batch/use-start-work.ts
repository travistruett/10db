import {
  BatchStartResult,
  TaskStartResult,
  type BatchId,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { readJson } from '../../../daemon/client';
import { useDaemon } from '../../../daemon/provider';
import { queryKeys } from '../../../daemon/queries';
import type { SheetMode } from './sheet-mode';

/** A sequence of starts stopped at a refusal; the tasks before it did start. */
export class StartStoppedError extends Error {
  override readonly name = 'StartStoppedError';
  readonly started: readonly TaskId[];
  constructor(started: readonly TaskId[], total: number, refusedTitle: string, cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(
      started.length === 0
        ? `${refusedTitle} was refused: ${why}`
        : `Started ${String(started.length)} of ${String(total)}; ${refusedTitle} was refused: ${why}`,
    );
    this.started = started;
  }
}

/** Thrown only if Start is pressed while the batch is busy; the sheet disables it then. */
export class BatchBusyError extends Error {
  override readonly name = 'BatchBusyError';
}

export interface StartWorkInput {
  readonly mode: SheetMode;
  readonly title: string;
  readonly tasks: readonly { readonly id: TaskId; readonly title: string }[];
}

function batchTitleOf(
  mode: Exclude<SheetMode, { kind: 'local' | 'busy' }>,
  title: string,
  tasks: StartWorkInput['tasks'],
): string {
  switch (mode.kind) {
    case 'new_batch':
      return title.trim();
    case 'join':
    case 'fix':
      return mode.title;
    // The daemon titles each worktree batch after its task; the request still needs one title.
    case 'worktrees':
      return tasks[0]?.title ?? title.trim();
  }
}

/**
 * Starts the ticked tasks in the sheet's order, which the daemon keeps as launch order. In a
 * pull-request project that is one batch request: it starts a new batch, joins the open one or
 * reopens the failed one, and ignores the title unless the batch is new; a worktree-mode project
 * gets a batch per task from the same request. A local project has no batch, so each task starts on
 * its own.
 */
export function useStartWork(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ mode, title, tasks }: StartWorkInput): Promise<void> => {
      switch (mode.kind) {
        case 'busy':
          throw new BatchBusyError(mode.reason);
        case 'new_batch':
        case 'join':
        case 'fix':
        case 'worktrees':
          await readJson(
            await client.projects[':projectId'].batches.$post({
              param: { projectId },
              json: {
                title: batchTitleOf(mode, title, tasks),
                taskIds: tasks.map((t) => t.id),
              },
            }),
            BatchStartResult,
          );
          return;
        case 'local': {
          const started: TaskId[] = [];
          for (const task of tasks) {
            try {
              await readJson(
                await client.tasks[':taskId'].start.$post({ param: { taskId: task.id } }),
                TaskStartResult,
              );
            } catch (error) {
              throw new StartStoppedError(started, tasks.length, task.title, error);
            }
            started.push(task.id);
          }
          return;
        }
      }
    },
    onSettled: () => refetchAfterStart(queryClient),
  });
}

/** `currentBatch` and `openBatches` live on the project, so the project list refetches too. */
function refetchAfterStart(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    queryClient.invalidateQueries({ queryKey: ['batches'] }),
    queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
    queryClient.invalidateQueries({ queryKey: ['candidates'] }),
  ]);
}

export interface AddFixTaskInput {
  readonly batchTitle: string;
  readonly batchId: BatchId;
  readonly taskId: TaskId;
}

/** Adds one task to an existing batch, which the daemon reopens if it failed. */
export function useAddFixTask(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ batchTitle, batchId, taskId }: AddFixTaskInput): Promise<void> => {
      await readJson(
        await client.projects[':projectId'].batches.$post({
          param: { projectId },
          json: { title: batchTitle, taskIds: [taskId], batchId },
        }),
        BatchStartResult,
      );
    },
    onSettled: () => refetchAfterStart(queryClient),
  });
}
