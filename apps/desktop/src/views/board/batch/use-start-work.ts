import { BatchDto, TaskStartResult, type ProjectId, type TaskId } from '@10db/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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

/**
 * Starts the ticked tasks in the sheet's order, which the daemon keeps as launch order. In a
 * pull-request project that is one batch request: it starts a new batch, joins the open one or
 * reopens the failed one, and ignores the title unless the batch is new. A local project has no
 * batch, so each task starts on its own.
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
          await readJson(
            await client.projects[':projectId'].batches.$post({
              param: { projectId },
              json: {
                title: mode.kind === 'new_batch' ? title.trim() : mode.title,
                taskIds: tasks.map((t) => t.id),
              },
            }),
            BatchDto,
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
    // `currentBatch` lives on the project, so the project list refetches too.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
        queryClient.invalidateQueries({ queryKey: ['batches'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
        queryClient.invalidateQueries({ queryKey: ['candidates'] }),
      ]),
  });
}
