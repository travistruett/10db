import {
  PicturesStatusDto,
  TaskScreensDto,
  type ProjectId,
  type TaskId,
  type TaskScreenId,
} from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { dataUrlOf } from './data-url';
import { useDaemon } from './provider';

// Workbench spec §10: a task's pictures of the builder's app, shown in its thread and its drawer, and
// Settings' line on the browser that takes them.

export const screenKeys = {
  all: ['task-screens'],
  of: (taskId: TaskId) => ['task-screens', taskId] as const,
} as const;

/** A task's pictures, oldest first. */
export function useTaskScreens(taskId: TaskId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: taskId ? screenKeys.of(taskId) : ['task-screens', 'none'],
    queryFn: async () =>
      taskId
        ? readJson(
            await client.tasks[':taskId'].screens.$get({ param: { taskId } }),
            TaskScreensDto,
          )
        : null,
    enabled: taskId !== null,
  });
}

/**
 * One picture as a data URL. A kept picture never changes, so it is read once; it is not under
 * `screenKeys.all`, which a new picture asks again.
 */
export function useScreenPicture(screenId: TaskScreenId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ['screen-pictures', screenId] as const,
    queryFn: async (): Promise<string> => {
      // A pruned picture answers 404 from the daemon's error handler, not the route.
      const res: Response = await client.screens[':screenId'].$get({ param: { screenId } });
      if (!res.ok) throw new Error(`The daemon answered HTTP ${String(res.status)}`);
      return dataUrlOf(await res.blob());
    },
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}

/** Settings › General: the browser for pictures and the project's last sign-in. */
export function usePicturesStatus(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ['pictures-status', projectId] as const,
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].pictures.$get({ param: { projectId } }),
        PicturesStatusDto,
      ),
    // The browser's download and a sign-in move on with no event of their own.
    refetchInterval: 5_000,
  });
}
