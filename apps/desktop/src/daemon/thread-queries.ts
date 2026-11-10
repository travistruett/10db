import { TaskMessageDto, TaskThreadDto, type TaskFileId, type TaskId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { dataUrlOf } from './data-url';
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

/**
 * A picture pasted into a task's thread, as a data URL. A kept picture never changes, so it is read
 * once; it is not under `threadKeys.all`, which a new message asks again.
 */
export function useTaskPicture(taskId: TaskId, fileId: TaskFileId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ['task-pictures', taskId, fileId] as const,
    queryFn: async (): Promise<string> => {
      // A picture the daemon no longer holds answers 404 from its error handler, not the route.
      const res: Response = await client.tasks[':taskId'].thread.pictures[':fileId'].$get({
        param: { taskId, fileId },
      });
      if (!res.ok) throw new Error(`The daemon answered HTTP ${String(res.status)}`);
      return dataUrlOf(await res.blob());
    },
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}

/** What the builder sends a task: words, pictures, or both. */
export interface TaskMessageSend {
  readonly text: string;
  readonly pictures: readonly File[];
}

/** Sends the builder's message and its pictures to the task's thread, as one multipart request. */
export function usePostTaskMessage(taskId: TaskId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ text, pictures }: TaskMessageSend) =>
      readJson(
        await client.tasks[':taskId'].thread.$post({
          param: { taskId },
          form: { text, picture: [...pictures] },
        }),
        TaskMessageDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: threadKeys.of(taskId) }),
  });
}
