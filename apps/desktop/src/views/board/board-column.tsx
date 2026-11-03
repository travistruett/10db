import {
  ActionIcon,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  VisuallyHidden,
} from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import type { ReactNode } from 'react';

/** An open column flexes between these widths, so the board fills the window and a card has room. */
export const COLUMN_MIN_WIDTH = 260;
export const COLUMN_MAX_WIDTH = 380;
/** A collapsed column's width: room for the count and the label turned on its side. */
export const RAIL_WIDTH = 44;

export interface BoardColumnProps {
  readonly label: string;
  readonly count: number;
  /** What the column holds, shown while it is empty. */
  readonly hint: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  /** Makes the list a drop target; on a rail, the rail is the target. */
  readonly listRef?: (element: HTMLElement | null) => void;
  /** A dragged card is over the column and the column would take it. */
  readonly targeted?: boolean;
  /** Shows the column as a narrow rail: the label and count, still a drop target. */
  readonly rail?: boolean;
  /** Collapses an open column, or opens a rail; absent where the builder can't collapse the column. */
  readonly onToggle?: () => void;
}

/**
 * One column: a header band over a list of task cards. It fills the board's height, so the whole
 * column is a drop target, and is dashed while empty. A rail is the same column folded to a narrow strip.
 */
export function BoardColumn({
  label,
  count,
  hint,
  children,
  footer,
  listRef,
  targeted = false,
  rail = false,
  onToggle,
}: BoardColumnProps) {
  const border = `1px ${count === 0 ? 'dashed' : 'solid'} var(--mantine-color-default-border)`;
  const outline = {
    // A drop target is outlined in the primary color, drawn inside so the column keeps its size.
    boxShadow: targeted ? 'inset 0 0 0 2px var(--mantine-color-blue-filled)' : 'none',
    background: targeted ? 'var(--mantine-color-blue-light)' : undefined,
    transition: 'box-shadow 150ms ease, background-color 150ms ease',
  };
  const tasks = (
    <>
      {count}
      <VisuallyHidden>{count === 1 ? ' task' : ' tasks'}</VisuallyHidden>
    </>
  );
  if (rail) {
    return (
      <Paper
        ref={listRef}
        radius="md"
        role="group"
        aria-label={`${label}, collapsed`}
        title={count === 0 ? hint : undefined}
        style={{
          flex: 'none',
          width: RAIL_WIDTH,
          border,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--mantine-spacing-xs)',
          paddingBlock: 'var(--mantine-spacing-xs)',
          ...outline,
        }}
      >
        {onToggle && count > 0 ? (
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={`Expand ${label}`}
            onClick={onToggle}
          >
            <IconChevronRight size={16} />
          </ActionIcon>
        ) : null}
        <Text size="sm" c="dimmed">
          {tasks}
        </Text>
        <Text fw={600} size="sm" style={{ writingMode: 'vertical-rl', whiteSpace: 'nowrap' }}>
          {label}
        </Text>
      </Paper>
    );
  }
  return (
    <Paper
      radius="md"
      style={{
        flex: '1 1 0',
        minWidth: COLUMN_MIN_WIDTH,
        maxWidth: COLUMN_MAX_WIDTH,
        border,
        overflow: 'hidden',
        ...outline,
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
          <Group gap={4} wrap="nowrap">
            <Text size="sm" c="dimmed">
              {tasks}
            </Text>
            {onToggle ? (
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={`Collapse ${label}`}
                onClick={onToggle}
              >
                <IconChevronLeft size={16} />
              </ActionIcon>
            ) : null}
          </Group>
        </Group>
        <Stack gap="xs" p="xs" flex={1} mih={0}>
          {count === 0 ? (
            <Text size="xs" c="dimmed">
              {hint}
            </Text>
          ) : null}
          {/* Only the cards scroll; the hint above and the footer below stay in view. The scrollbar shows on hover in a strip of its own beside the cards ('y' always reserves it, so cards never change width). */}
          <ScrollArea
            type="hover"
            scrollbars="y"
            offsetScrollbars="y"
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
