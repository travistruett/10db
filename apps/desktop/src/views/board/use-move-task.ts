import { TaskDto, type ProjectId, type TaskId, type TaskMove } from '@10db/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { readJson } from '../../daemon/client';
import { useDaemon } from '../../daemon/provider';
import { queryKeys } from '../../daemon/queries';
import { placeLocally } from './drop-rules';

export interface MoveTaskInput {
  readonly taskId: TaskId;
  readonly move: TaskMove;
  readonly order: number;
}

/** Places a card at once and rolls back if the daemon refuses; the event stream brings the real order. */
export function useMoveTask(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const key = queryKeys.tasks(projectId);
  return useMutation({
    mutationFn: async ({ taskId, move }: MoveTaskInput) =>
      readJson(
        await client.tasks[':taskId'].move.$post({ param: { taskId }, json: move }),
        TaskDto,
      ),
    onMutate: async ({ taskId, move, order }: MoveTaskInput) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<TaskDto[]>(key);
      if (previous) queryClient.setQueryData(key, placeLocally(previous, taskId, order, move.to));
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
