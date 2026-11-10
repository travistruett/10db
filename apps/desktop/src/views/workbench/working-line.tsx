import { Box, Group, Text } from '@mantine/core';
import { StatusDot } from '../factory/status-dot';
import type { LiveLine } from './live-line';

/**
 * The working turn's line at the end of the thread: a blue dot, the time and what the agent is doing,
 * and the files changed so far. It changes as the agent works, so it is not a live region.
 */
export function WorkingLine({ line }: { readonly line: LiveLine }) {
  return (
    <Box px="md" pb="sm">
      <Group gap="xs" wrap="nowrap" align="baseline">
        <StatusDot color="blue" />
        <Text size="sm" truncate="end">
          {line.doing}
        </Text>
      </Group>
      {line.files === null ? null : (
        <Text size="xs" c="dimmed" pl={16}>
          {line.files}
        </Text>
      )}
    </Box>
  );
}
