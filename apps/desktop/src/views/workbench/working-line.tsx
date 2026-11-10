import { Anchor, Box, Group, Text } from '@mantine/core';
import { StatusDot } from '../factory/status-dot';
import type { LiveLine } from './live-line';

export interface WorkingLineProps {
  readonly line: LiveLine;
  /** Opens the turn's log, which the page keeps open after the turn ends. */
  readonly onShowLog: () => void;
}

/**
 * The working turn's line at the end of the thread: a blue dot, the time and what the agent is doing,
 * and the files changed so far beside Show Log. It changes as the agent works, so it is not a live
 * region.
 */
export function WorkingLine({ line, onShowLog }: WorkingLineProps) {
  return (
    <Box px="md" pb="sm">
      <Group gap="xs" wrap="nowrap" align="baseline">
        <StatusDot color="blue" />
        <Text size="sm" truncate="end">
          {line.doing}
        </Text>
      </Group>
      <Group gap={4} pl={16} wrap="nowrap" align="baseline">
        {line.files === null ? null : (
          <>
            <Text size="xs" c="dimmed">
              {line.files}
            </Text>
            <Text size="xs" c="dimmed" aria-hidden="true">
              ·
            </Text>
          </>
        )}
        <Anchor component="button" type="button" size="xs" onClick={onShowLog}>
          Show Log
        </Anchor>
      </Group>
    </Box>
  );
}
