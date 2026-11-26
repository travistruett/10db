import type { InboxItemDto, TaskId } from '@10db/contracts';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useWorkstreams } from '../../daemon/queries';
import { CardLinkButton } from './card-actions';

/** Opens a task's drawer over the Inbox (`?task=`), so Back closes it and a reload keeps it. */
export function useViewTask(): (taskId: TaskId) => void {
  const navigate = useNavigate({ from: '/inbox' });
  return (taskId) => {
    void navigate({ to: '/inbox', search: (prev) => ({ ...prev, task: taskId }) });
  };
}

/**
 * View Task for the bar of a card whose target names a run: the task of that run, live or over, in its drawer
 * over the Inbox, so the builder never leaves it. It shows from the card's own target at once, loading until the
 * runs are read, so the bar keeps its shape; a run the list doesn't hold has no task to open. `shown` is false
 * for a card outside the Inbox's content (framed), which has no drawer to open.
 */
export function useViewTaskButton(item: InboxItemDto, shown: boolean): ReactNode {
  const workstreamId = item.targets[0]?.workstreamId;
  const workstreams = useWorkstreams({ active: false });
  const viewTask = useViewTask();
  if (!shown || workstreamId === undefined) return null;
  const taskId = workstreams.data?.find((w) => w.id === workstreamId)?.taskId ?? null;
  if (taskId === null && !workstreams.isPending) return null;
  return (
    <CardLinkButton
      label="View Task"
      loading={taskId === null}
      onClick={() => {
        if (taskId !== null) viewTask(taskId);
      }}
    />
  );
}
