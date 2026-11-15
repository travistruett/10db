import { Group, Stack, Text } from '@mantine/core';
import { IconGauge } from '@tabler/icons-react';
import { useAdmission } from '../../daemon/admission-queries';

/**
 * Says why new work waits on this Mac: a load that has stayed high, low free disk, or the lane cap
 * across all projects. Nothing shows while nothing holds.
 */
export function AdmissionNote() {
  const holds = useAdmission().data?.holds ?? [];
  if (holds.length === 0) return null;
  return (
    <Group gap={6} wrap="nowrap" align="flex-start" role="status" aria-label="New work held">
      <IconGauge size={16} stroke={1.5} color="var(--mantine-color-yellow-6)" aria-hidden />
      <Stack gap={0}>
        {holds.map((hold) => (
          <Text key={hold.kind} size="xs" c="dimmed">
            {hold.line}
          </Text>
        ))}
      </Stack>
    </Group>
  );
}
