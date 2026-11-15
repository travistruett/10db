import { Box, Group, Text, UnstyledButton } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useRowOpen } from './row-state';

/** "Worked · 3 Steps"; a run of reasoning alone is "Thought". */
export function workLabel(steps: number): string {
  if (steps === 0) return 'Thought';
  return `Worked · ${String(steps)} ${steps === 1 ? 'Step' : 'Steps'}`;
}

export interface WorkRowProps {
  readonly id: string;
  readonly steps: number;
  /** Open from the start, for a run holding a row the builder was sent to. */
  readonly defaultOpen: boolean;
  /** The run's own rows, drawn only while it is open. */
  readonly children: ReactNode;
}

/**
 * The agent's settled work as one row, closed until the builder opens it. Whether it is open is the
 * list's row state, so a windowed list that scrolls it away and back keeps it as it was left.
 */
export function WorkRow({ id, steps, defaultOpen, children }: WorkRowProps) {
  const [opened, setOpened] = useRowOpen(id, defaultOpen ? 'open' : 'closed');
  const open = opened !== 'closed';
  return (
    <Box>
      <UnstyledButton
        aria-expanded={open}
        onClick={() => {
          setOpened(open ? 'closed' : 'open');
        }}
        h={28}
      >
        <Group gap={8} wrap="nowrap" px={4}>
          <Text size="sm" c="dimmed">
            {workLabel(steps)}
          </Text>
          <IconChevronRight
            size={14}
            stroke={1.5}
            aria-hidden="true"
            style={{
              color: 'var(--mantine-color-dimmed)',
              transform: open ? 'rotate(90deg)' : undefined,
            }}
          />
        </Group>
      </UnstyledButton>
      {open ? <Box pl={8}>{children}</Box> : null}
    </Box>
  );
}
