import { TaskThreadDto, type TaskId } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

export const threadKeys = {
  all: ['task-thread'],
  of: (taskId: TaskId) => ['task-thread', taskId] as const,
} as const;

/** A task's thread, oldest first: the builder's messages, the agent's replies and the notices. */
export function useTaskThread(taskId: TaskId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: taskId ? threadKeys.of(taskId) : ['task-thread', 'none'],
    queryFn: async () =>
      taskId
        ? readJson(await client.tasks[':taskId'].thread.$get({ param: { taskId } }), TaskThreadDto)
        : null,
    enabled: taskId !== null,
  });
}
