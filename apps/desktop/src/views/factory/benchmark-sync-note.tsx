import { Group, Text } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import { useSystemCheck } from '../../daemon/queries';
import { syncNeedsBuilder } from '../../shell/benchmark-sync-urgency';

/** A failed Artificial Analysis sync that a later sync clears on its own: a dimmed line, not an alert. */
export function BenchmarkSyncNote() {
  const warning = useSystemCheck().data?.benchmarkSync;
  if (!warning || syncNeedsBuilder(warning)) return null;
  return (
    <Group gap={6} wrap="nowrap">
      <IconCloudOff size={16} stroke={1.5} color="var(--mantine-color-dimmed)" aria-hidden />
      <Text size="xs" c="dimmed">
        {`${warning.message}. Routing uses the last good scores.`}
      </Text>
    </Group>
  );
}
