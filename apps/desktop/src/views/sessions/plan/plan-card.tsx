import { Box, Group, Text } from '@mantine/core';
import type { ReactNode } from 'react';

export interface PlanCardProps {
  /** The card's head: a goal's own row, or a name with its count. */
  readonly head: ReactNode;
  readonly children?: ReactNode;
}

/**
 * A card of the Plan: the panel tone (bg_1 in both schemes), one step off the panel, which keeps the
 * conversation's surface. No outline, radius md.
 */
export function PlanCard({ head, children }: PlanCardProps) {
  return (
    <Box
      component="li"
      p={8}
      style={{
        listStyle: 'none',
        borderRadius: 'var(--mantine-radius-md)',
        background: 'var(--tendb-color-panel)',
      }}
    >
      {head}
      {children}
    </Box>
  );
}

/** The head of a card that holds a kind of row: its name (13 / 600, dim), a dim count and a dim note. */
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
    <Box px={12} mb={8}>
      <Group gap={8} wrap="nowrap" align="baseline">
        <Text fz={13} fw={600} c="dimmed">
          {name}
        </Text>
        <Text fz={12} c="dimmed">
          {count}
        </Text>
      </Group>
      {note === undefined ? null : (
        <Text fz={12} c="dimmed">
          {note}
        </Text>
      )}
    </Box>
  );
}
