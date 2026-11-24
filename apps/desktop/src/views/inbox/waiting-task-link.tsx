import type { InboxItemDto } from '@10db/contracts';
import { Anchor, Group, Text } from '@mantine/core';
import { useWorkstreams } from '../../daemon/queries';
import { useOpenTask } from '../sessions/open-session';

/**
 * The task a waiting question holds up, as a link that opens it on the Board. A question with no run, or one
 * whose run has ended, shows nothing.
 */
export function WaitingTaskLink({ item }: { readonly item: InboxItemDto }) {
  const workstreamId = item.targets[0]?.workstreamId;
  const workstreams = useWorkstreams({ active: true });
  const openTask = useOpenTask();
  const run =
    workstreamId === undefined ? undefined : workstreams.data?.find((w) => w.id === workstreamId);
  if (run === undefined) return null;
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
        Holds up
      </Text>
      <Anchor
        component="button"
        type="button"
        size="sm"
        truncate
        onClick={() => {
          void openTask({ taskId: run.taskId, projectId: run.projectId });
        }}
      >
        {run.taskTitle}
      </Anchor>
    </Group>
  );
}
