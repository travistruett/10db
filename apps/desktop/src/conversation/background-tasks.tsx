import type { AgentCapabilitiesDto, BackgroundTaskDto } from '@10db/contracts';
import { Box, Group, Stack, Text } from '@mantine/core';
import { IconEye, IconRobot, IconTerminal2 } from '@tabler/icons-react';

const KIND_WORDS: Readonly<Record<BackgroundTaskDto['kind'], string>> = {
  shell: 'Command',
  monitor: 'Monitor',
  agent: 'Subagent',
  other: 'Task',
};

function KindIcon({ kind }: { readonly kind: BackgroundTaskDto['kind'] }) {
  switch (kind) {
    case 'agent':
      return <IconRobot size={14} aria-hidden />;
    case 'monitor':
      return <IconEye size={14} aria-hidden />;
    case 'shell':
    case 'other':
      return <IconTerminal2 size={14} aria-hidden />;
  }
}

/** What a row says it is: its kind, and a subagent's type. */
function kindLabel(task: BackgroundTaskDto): string {
  return task.agent === null ? KIND_WORDS[task.kind] : `${KIND_WORDS[task.kind]} · ${task.agent}`;
}

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
            <KindIcon kind={task.kind} />
            <Text size="xs" c="dimmed" style={{ flex: 'none' }}>
              {kindLabel(task)}
            </Text>
            <Text size="sm" truncate="end" title={task.description}>
              {task.description}
            </Text>
          </Group>
        ))}
      </Stack>
    </Box>
  );
}
