import type { InboxItemDto } from '@10db/contracts';
import { Group, Text } from '@mantine/core';
import { useWorkstreams } from '../../daemon/queries';

/**
 * The task a waiting question holds up, by its title; the bar's View Task opens it. A question with no run, or
 * one whose run has ended, shows nothing.
 */
export function WaitingTaskLine({ item }: { readonly item: InboxItemDto }) {
  const workstreamId = item.targets[0]?.workstreamId;
  const workstreams = useWorkstreams({ active: true });
  const run =
    workstreamId === undefined ? undefined : workstreams.data?.find((w) => w.id === workstreamId);
  if (run === undefined) return null;
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
        Holds up
      </Text>
      <Text size="sm" truncate>
        {run.taskTitle}
      </Text>
    </Group>
  );
}
