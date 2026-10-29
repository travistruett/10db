import { Group, Paper, ScrollArea, Stack, Text, VisuallyHidden } from '@mantine/core';
import type { ReactNode } from 'react';

export interface BoardColumnProps {
  readonly label: string;
  readonly count: number;
  /** What the column holds, shown while it is empty. */
  readonly hint: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  /** Makes the list a drop target. */
  readonly listRef?: (element: HTMLElement | null) => void;
  /** A dragged card is over the column and the column would take it. */
  readonly targeted?: boolean;
}

/** One column: a header band over a list of task cards. It fills the board's height, so the whole column is a drop target, and is dashed while empty. */
export function BoardColumn({
  label,
  count,
  hint,
  children,
  footer,
  listRef,
  targeted = false,
}: BoardColumnProps) {
  const border = `1px ${count === 0 ? 'dashed' : 'solid'} var(--mantine-color-default-border)`;
  return (
    <Paper
      radius="md"
      w={240}
      style={{
        flex: 'none',
        border,
        overflow: 'hidden',
        // A drop target is outlined in the primary color, drawn inside so the column keeps its size.
        boxShadow: targeted ? 'inset 0 0 0 2px var(--mantine-color-blue-filled)' : 'none',
        background: targeted ? 'var(--mantine-color-blue-light)' : undefined,
        transition: 'box-shadow 150ms ease, background-color 150ms ease',
      }}
    >
      <Stack gap={0} h="100%">
        {/* The band has a fixed height, in the controls' color, so every header reads as one row. */}
        <Group
          justify="space-between"
          wrap="nowrap"
          h={40}
          px="sm"
          bg="var(--mantine-color-default)"
          style={{ flex: 'none', borderBottom: border }}
        >
          <Text fw={600} size="sm">
            {label}
          </Text>
          <Text size="sm" c="dimmed">
            {count}
            <VisuallyHidden>{count === 1 ? ' task' : ' tasks'}</VisuallyHidden>
          </Text>
        </Group>
        <Stack gap="xs" p="xs" flex={1} mih={0}>
          {count === 0 ? (
            <Text size="xs" c="dimmed">
              {hint}
            </Text>
          ) : null}
          {/* Only the cards scroll; the hint above and the footer below stay in view. */}
          <ScrollArea
            type="hover"
            scrollbars="y"
            flex={1}
            mih={0}
            styles={{ content: { minHeight: '100%' } }}
          >
            <Stack
              component="ul"
              ref={listRef}
              gap="xs"
              m={0}
              p={0}
              mih="100%"
              style={{ listStyle: 'none' }}
              aria-label={`${label} tasks`}
            >
              {children}
            </Stack>
          </ScrollArea>
          {footer}
        </Stack>
      </Stack>
    </Paper>
  );
}
