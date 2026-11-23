import {
  PicturesStatusDto,
  TaskDesignCheckDto,
  TaskScreensDto,
  type DesignCheckId,
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

/** Settings › App Preview: the browser for pictures and the project's last sign-in. */
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

export const designCheckKeys = {
  all: ['design-checks'],
  of: (taskId: TaskId) => ['design-checks', taskId] as const,
} as const;

/** A task's newest design check: its mock-up drawn, the page shot as it was, and the verdict. */
export function useTaskDesignCheck(taskId: TaskId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: designCheckKeys.of(taskId),
    queryFn: async () =>
      readJson(
        await client.tasks[':taskId']['design-checks'].$get({ param: { taskId } }),
        TaskDesignCheckDto,
      ),
  });
}

/** One picture of a design check as a data URL; a check's pictures never change, so each is read once. */
export function useDesignCheckPicture(checkId: DesignCheckId, part: 'mockup' | number) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ['design-check-pictures', checkId, part] as const,
    queryFn: async (): Promise<string> => {
      const res: Response =
        part === 'mockup'
          ? await client['design-checks'][':checkId'].mockup.$get({ param: { checkId } })
          : await client['design-checks'][':checkId'].shots[':index'].$get({
              param: { checkId, index: String(part) },
            });
      if (!res.ok) throw new Error(`The daemon answered HTTP ${String(res.status)}`);
      return dataUrlOf(await res.blob());
    },
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}
