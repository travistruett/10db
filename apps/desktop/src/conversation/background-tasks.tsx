import type { AgentCapabilitiesDto, BackgroundTaskDto } from '@10db/contracts';
import { Box, Collapse, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconRobot,
  IconTerminal2,
} from '@tabler/icons-react';
import { useState } from 'react';

/** The tallest the open list grows before it scrolls inside itself. */
const LIST_MAX_HEIGHT = 'min(120px, 16vh)';

/** What Claude Code names a session that was backgrounded itself. */
const MAIN_SESSION = 'main-session';

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
  if (task.agent === MAIN_SESSION) return 'Main session';
  return task.agent === null ? KIND_WORDS[task.kind] : `${KIND_WORDS[task.kind]} · ${task.agent}`;
}

export interface BackgroundTasksProps {
  readonly capabilities: Pick<AgentCapabilitiesDto, 'backgroundTasks' | 'label'>;
  readonly tasks: readonly BackgroundTaskDto[];
  /** A card waits on the builder: the list starts folded, so the question keeps the room. */
  readonly cardWaiting?: boolean;
}

/**
 * The commands and subagents a chat's session started that still run, above the composer. It folds
 * to its heading and scrolls inside a height cap. An agent that reports none says so in one dim line
 * instead of drawing an empty panel.
 */
export function BackgroundTasks({
  capabilities,
  tasks,
  cardWaiting = false,
}: BackgroundTasksProps) {
  const [picked, setPicked] = useState<boolean | null>(null);
  const folded = picked ?? cardWaiting;
  if (!capabilities.backgroundTasks)
    return (
      <Box px="md" py={4} data-background-tasks="unavailable" style={{ flex: 'none' }}>
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
      style={{ flex: 'none', borderTop: '1px solid var(--mantine-color-default-border)' }}
    >
      <UnstyledButton
        aria-expanded={!folded}
        w="100%"
        onClick={() => {
          setPicked(!folded);
        }}
      >
        <Group gap={6} wrap="nowrap">
          {folded ? (
            <IconChevronRight size={14} aria-hidden />
          ) : (
            <IconChevronDown size={14} aria-hidden />
          )}
          <Text size="xs" c="dimmed">
            Running in the background · {tasks.length}
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={!folded}>
        <Stack
          gap={2}
          mt={4}
          component="ul"
          m={0}
          p={0}
          style={{ listStyle: 'none', maxHeight: LIST_MAX_HEIGHT, overflowY: 'auto' }}
        >
          {tasks.map((task) => (
            <Group key={task.id} component="li" gap={8} wrap="nowrap">
              <KindIcon kind={task.kind} />
              <Text
                size="xs"
                c="dimmed"
                truncate="end"
                maw={160}
                title={kindLabel(task)}
                style={{ flex: 'none' }}
              >
                {kindLabel(task)}
              </Text>
              <Text size="sm" truncate="end" title={task.description}>
                {task.description}
              </Text>
            </Group>
          ))}
        </Stack>
      </Collapse>
    </Box>
  );
}
