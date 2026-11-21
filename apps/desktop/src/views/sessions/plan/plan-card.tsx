import { Box, Group, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { CountBadge } from '../../../shell/count-badge';

export interface PlanCardProps {
  /** The card's head: a title row of its own, such as a goal's, or a name with its count. */
  readonly head: ReactNode;
  readonly children?: ReactNode;
  readonly label?: string;
}

/**
 * A card of the Plan: one tone down from the panel, no outline, radius md. The panel paints the Board's
 * card tone and the card the Board's tray tone, so in both schemes the card sits recessed in it.
 */
export function PlanCard({ head, children, label }: PlanCardProps) {
  return (
    <Box
      component="li"
      aria-label={label}
      p="xs"
      style={{
        listStyle: 'none',
        borderRadius: 'var(--mantine-radius-md)',
        background: 'var(--tendb-color-column)',
      }}
    >
      {head}
      {children}
    </Box>
  );
}

/** The head of a card that holds a kind of row: its name, a count and a dim note. */
export function CardName({
  name,
  count,
  note,
}: {
  readonly name: string;
  readonly count: number;
  readonly note?: string;
}) {
  return (
    <Box px={8} pt={4} pb={2}>
      <Group gap={6} wrap="nowrap">
        <Text size="sm" fw={500} c="bright">
          {name}
        </Text>
        <CountBadge count={count} />
      </Group>
      {note === undefined ? null : (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      )}
    </Box>
  );
}
