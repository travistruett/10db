import type { InboxItemDto, TaskId } from '@10db/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useWorkstreams } from '../../daemon/queries';
import { CardLinkButton } from './card-actions';

/** The task a card's run works on, whether the run is live or over; null for a card that names no run. */
export function useTaskOfRun(item: InboxItemDto): TaskId | null {
  const workstreamId = item.targets[0]?.workstreamId;
  const workstreams = useWorkstreams({ active: false });
  if (workstreamId === undefined) return null;
  return workstreams.data?.find((w) => w.id === workstreamId)?.taskId ?? null;
}

/** Opens a task's drawer over the Inbox (`?task=`), so Back closes it and a reload keeps it. */
export function useViewTask(): (taskId: TaskId) => void {
  const navigate = useNavigate({ from: '/inbox' });
  return (taskId) => {
    void navigate({ to: '/inbox', search: (prev) => ({ ...prev, task: taskId }) });
  };
}

/** View Task: the card's task in its drawer, over the Inbox, so the builder never leaves it. */
export function ViewTaskButton({ taskId }: { readonly taskId: TaskId }) {
  const viewTask = useViewTask();
  return (
    <CardLinkButton
      label="View Task"
      onClick={() => {
        viewTask(taskId);
      }}
    />
  );
}
