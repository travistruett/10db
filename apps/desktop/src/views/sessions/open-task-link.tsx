import type { ProjectId, TaskId } from '@10db/contracts';
import { Anchor } from '@mantine/core';
import { useTaskSession } from '../../daemon/task-session-queries';
import { useOpenTask } from './open-session';

/**
 * Open Session for a task Do It made: it opens the task in the Board. A task with no session to open (made on
 * the Board, or one the daemon doesn't know) shows nothing.
 */
export function OpenTaskLink({
  taskId,
  projectId,
}: {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
}) {
  const session = useTaskSession(taskId).data;
  const openTask = useOpenTask();
  if (session === undefined || session.fromChat === null) return null;
  return (
    <Anchor
      component="button"
      type="button"
      size="sm"
      onClick={() => {
        void openTask({ taskId, projectId });
      }}
    >
      Open Session
    </Anchor>
  );
}
