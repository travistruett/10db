import { LinearPostDto, type TaskId } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

export const linearPostKeys = {
  all: ['linear-posts'],
  of: (taskId: TaskId) => ['linear-posts', taskId] as const,
} as const;

/** The updates a task's Linear issue is owed or has had, newest first. */
export function useTaskLinearPosts(taskId: TaskId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: linearPostKeys.of(taskId),
    queryFn: async () =>
      readJson(
        await client.tasks[':taskId']['linear-posts'].$get({ param: { taskId } }),
        z.array(LinearPostDto),
      ),
  });
}
