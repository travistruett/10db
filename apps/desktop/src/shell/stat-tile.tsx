import { Group, Paper, Text, type MantineColor } from '@mantine/core';
import type { ReactNode } from 'react';
import classes from './stat-tile.module.css';

/**
 * One figure on a raised tile: a large count, an optional "of" note, and a mark with its label under it. A tile
 * given `onToggle` is a toggle button (a filter): `selected` outlines it in `color`.
 */
export function StatTile({
  n,
  of,
  mark,
  label,
  color,
  selected,
  onToggle,
}: {
  /** The count; null reads as a dash when there is nothing to count yet. */
  readonly n: number | null;
  readonly of?: string | undefined;
  readonly mark: ReactNode;
  readonly label: string;
  /** The tile's color, outlining it while selected. */
  readonly color?: MantineColor;
  readonly selected?: boolean;
  readonly onToggle?: () => void;
}) {
  const body = (
    <>
      <Group gap={8} align="baseline">
        <Text
          fz={24}
          fw={600}
          lh={1}
          c={n === null || n === 0 ? 'dimmed' : 'bright'}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {n ?? '—'}
        </Text>
        {of === undefined ? null : (
          <Text size="xs" c="dimmed">
            {of}
          </Text>
        )}
      </Group>
      <Group gap={6} mt={12} wrap="nowrap" align="center">
        {mark}
        <Text size="xs" lh={1}>
          {label}
        </Text>
      </Group>
    </>
  );
  if (onToggle === undefined)
    return (
      <Paper variant="raised" radius="md" px={16} py={14}>
        {body}
      </Paper>
    );
  return (
    <Paper
      variant="raised"
      radius="md"
      component="button"
      type="button"
      px={16}
      py={14}
      className={classes['toggle']}
      aria-pressed={selected === true}
      data-selected={selected === true ? '' : undefined}
      style={{
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        ...(color === undefined ? {} : { '--tile-color': `var(--mantine-color-${color}-filled)` }),
      }}
      onClick={onToggle}
    >
      {body}
    </Paper>
  );
}
