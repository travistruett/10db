import type { AgentCapabilitiesDto, BackgroundTaskDto } from '@10db/contracts';
import { Box, Group, Stack, Text } from '@mantine/core';
import { IconTerminal2 } from '@tabler/icons-react';

export interface BackgroundTasksProps {
  readonly capabilities: Pick<AgentCapabilitiesDto, 'backgroundTasks' | 'label'>;
  readonly tasks: readonly BackgroundTaskDto[];
}

/**
 * The commands and subagents a chat's session started that still run, above the composer. An agent that
 * reports none says so in one dim line instead of drawing an empty panel.
 */
export function BackgroundTasks({ capabilities, tasks }: BackgroundTasksProps) {
  if (!capabilities.backgroundTasks)
    return (
      <Box px="md" py={4} data-background-tasks="unavailable">
        <Text size="xs" c="dimmed">
          {capabilities.label} doesn’t report background tasks.
        </Text>
      </Box>
    );
  if (tasks.length === 0) return null;
  return (
    <Box
      px="md"
      py={6}
      data-background-tasks
      style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
    >
      <Text size="xs" c="dimmed">
        Running in the background · {tasks.length}
      </Text>
      <Stack gap={2} mt={4} component="ul" m={0} p={0} style={{ listStyle: 'none' }}>
        {tasks.map((task) => (
          <Group key={task.id} component="li" gap={8} wrap="nowrap">
            <IconTerminal2 size={14} aria-hidden />
            <Text size="sm" truncate="end" title={task.description}>
              {task.description}
            </Text>
          </Group>
        ))}
      </Stack>
    </Box>
  );
}
