import type { ProjectId, TaskId } from '@10db/contracts';
import { Anchor, Button } from '@mantine/core';
import { useTaskSession } from '../../daemon/task-session-queries';
import { useOpenTask } from './open-session';

/**
 * Open Session for a task Do It made: it opens the task in the Board. A task with no session to open (made on
 * the Board, or one the daemon doesn't know) shows nothing. `asButton` draws it as a default button, for an
 * Inbox card's bar.
 */
export function OpenTaskLink({
  taskId,
  projectId,
  asButton = false,
}: {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly asButton?: boolean;
}) {
  const session = useTaskSession(taskId).data;
  const openTask = useOpenTask();
  if (session === undefined || session.fromChat === null) return null;
  const open = (): void => {
    void openTask({ taskId, projectId });
  };
  return asButton ? (
    <Button variant="default" onClick={open}>
      Open Session
    </Button>
  ) : (
    <Anchor component="button" type="button" size="sm" onClick={open}>
      Open Session
    </Anchor>
  );
}
