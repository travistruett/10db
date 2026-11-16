import { TaskSessionDto, type TaskId } from '@10db/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { readJson, type DaemonClient } from './client';
import { useDaemon } from './provider';

// Sessions UI §14: what a task's tab reads of the task: where it works and what it came from. A task's
// workstream, pass and conversation events move it, so its key is one the `task`, `workstream`, `pass`
// and `chat` events all refetch.

export const taskSessionKeys = {
  all: ['tasks', 'session'],
  one: (taskId: TaskId) => ['tasks', 'session', taskId] as const,
} as const;

function sessionOptions(client: DaemonClient, taskId: TaskId) {
  return {
    queryKey: taskSessionKeys.one(taskId),
    queryFn: async () =>
      readJson(await client.tasks[':taskId'].session.$get({ param: { taskId } }), TaskSessionDto),
  };
}

/** One task's session; absent while `taskId` is null. */
export function useTaskSession(taskId: TaskId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: taskId === null ? ['tasks', 'session', 'none'] : taskSessionKeys.one(taskId),
    queryFn: async () =>
      taskId === null
        ? Promise.reject(new Error('No task'))
        : sessionOptions(client, taskId).queryFn(),
    enabled: taskId !== null,
  });
}

/** The sessions of the tasks whose tabs are open, by task. */
export function useTaskSessions(taskIds: readonly TaskId[]): ReadonlyMap<TaskId, TaskSessionDto> {
  const { client } = useDaemon();
  const results = useQueries({ queries: taskIds.map((id) => sessionOptions(client, id)) });
  const map = new Map<TaskId, TaskSessionDto>();
  results.forEach((result, index) => {
    const id = taskIds[index];
    if (id !== undefined && result.data !== undefined) map.set(id, result.data);
  });
  return map;
}
