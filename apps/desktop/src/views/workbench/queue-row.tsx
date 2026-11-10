import { Group, Text, UnstyledButton } from '@mantine/core';
import { StatusDot } from '../factory/status-dot';
import type { QueueRow as Row } from './queue-rows';

export interface QueueRowProps {
  readonly row: Row;
  readonly current: boolean;
  readonly onSelect: () => void;
}

/**
 * One page of the queue, drawn as a row of Factory's list (design review D13): a status dot, the page's
 * name, heavier when it waits on the builder, and one short state line. No border; a hairline under
 * the row; the selected row on the control fill; a row that needs nothing in dimmed text.
 */
export function QueueRow({ row, current, onSelect }: QueueRowProps) {
  return (
    <UnstyledButton
      w="100%"
      px="sm"
      py={6}
      aria-current={current ? 'true' : undefined}
      {...(row.dimmed ? { c: 'dimmed' } : {})}
      onClick={onSelect}
      style={{
        display: 'block',
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: current ? 'var(--mantine-color-default)' : undefined,
      }}
    >
      <Group gap="sm" wrap="nowrap" align="baseline">
        <StatusDot color={row.state.color} />
        <Text
          component="span"
          size="sm"
          fw={row.state.needsYou ? 500 : 400}
          style={{ flex: 'none' }}
        >
          {row.page.area}
        </Text>
        <Text component="span" size="sm" truncate="end">
          {row.state.line}
        </Text>
      </Group>
    </UnstyledButton>
  );
}
