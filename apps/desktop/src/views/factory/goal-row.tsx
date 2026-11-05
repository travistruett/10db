import { Box, Group, Text, UnstyledButton, type MantineColor } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { StatusDot } from './status-dot';

export interface GoalRowProps {
  readonly title: string;
  /** The one-line verdict beside the title. */
  readonly line: string;
  /** The plain-text news that ends the line, such as "· 3 new since 3h ago". */
  readonly news?: string | undefined;
  /** The status dot's color; a row that is not a goal's status (the Done line) has none. */
  readonly color?: MantineColor;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** The region under the row; rendered only while the row is open. */
  readonly children: ReactNode;
}

/**
 * One row of the goal list: a button that opens and closes the region under it, with no border or
 * shadow of its own. Rows are separated by hairlines, and the open row's whole area takes the
 * control background. Escape inside the open region closes it and returns to the button.
 */
export function GoalRow({ title, line, news, color, expanded, onToggle, children }: GoalRowProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const regionId = `${id}-region`;
  const button = useRef<HTMLButtonElement>(null);
  const Chevron = expanded ? IconChevronDown : IconChevronRight;

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !expanded) return;
    // A dialog opened from the region closes on its own Escape and leaves the goal open.
    if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
    // A row inside another open row's region closes alone.
    event.stopPropagation();
    onToggle();
    button.current?.focus();
  }

  return (
    <Box
      onKeyDown={onKeyDown}
      style={{
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: expanded ? 'var(--mantine-color-default)' : undefined,
      }}
    >
      <UnstyledButton
        ref={button}
        w="100%"
        px="sm"
        py="xs"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => {
          onToggle();
          // macOS WebKit, the app's window, gives a clicked button no focus, and Escape needs it here.
          button.current?.focus();
        }}
        style={{ borderRadius: 'var(--mantine-radius-md)' }}
      >
        <Group gap="sm" wrap="nowrap" align="baseline">
          <Chevron
            size={16}
            stroke={1.5}
            aria-hidden
            style={{ alignSelf: 'center', flex: 'none' }}
          />
          {color ? <StatusDot color={color} /> : null}
          <Text id={titleId} fw={600} size="sm" style={{ flex: 'none' }}>
            {title}
          </Text>
          <Text size="sm" c="dimmed" style={{ minWidth: 0 }}>
            {news ? `${line} ${news}` : line}
          </Text>
        </Group>
      </UnstyledButton>
      {expanded ? (
        <Box id={regionId} role="region" aria-labelledby={titleId} px="md" pt="xs" pb="md">
          {children}
        </Box>
      ) : null}
    </Box>
  );
}
