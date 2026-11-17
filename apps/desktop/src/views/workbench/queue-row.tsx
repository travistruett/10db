import { Group, Text, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';
import { StatusDot } from '../factory/status-dot';
import type { QueueRow as Row } from './queue-rows';
import { CodeSpans } from '../../shell/code-spans';

export interface QueueRowProps {
  readonly row: Row;
  readonly current: boolean;
  readonly onSelect: () => void;
  /** The row's menu, drawn beside its button; null when the row has none. */
  readonly menu: ReactNode;
}

/**
 * One page of the queue, drawn as a row of Factory's list (design review D13): a status dot, the page's
 * name, heavier when it waits on the builder, and its state line under the name. No border; a hairline under
 * the row; the selected row on the control fill; a row that needs nothing in dimmed text.
 */
export function QueueRow({ row, current, onSelect, menu }: QueueRowProps) {
  return (
    <Group
      gap={0}
      wrap="nowrap"
      style={{
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: current ? 'var(--mantine-color-default)' : undefined,
      }}
    >
      <UnstyledButton
        px="sm"
        py={8}
        aria-current={current ? 'true' : undefined}
        {...(row.dimmed ? { c: 'dimmed' } : {})}
        onClick={(event) => {
          // A pointer click hands the cursor on to the page's composer, as WebKit does by never
          // focusing the button; Enter on a focused row (detail 0) keeps it here for J and K.
          if (event.detail > 0) event.currentTarget.blur();
          onSelect();
        }}
        style={{ display: 'block', flex: 1, minWidth: 0 }}
      >
        <Group gap="sm" wrap="nowrap" align="center">
          <StatusDot color={row.state.color} />
          <Text
            component="span"
            size="sm"
            fw={row.state.needsYou ? 500 : 400}
            truncate="end"
            style={{ minWidth: 0 }}
          >
            {row.page.label}
          </Text>
        </Group>
        {/* The state goes under the name, beside the dot's column, so it has the row's width and wraps
            there: "Working · 4 min · median 6" outgrows the queue beside a name. */}
        <Text component="span" size="xs" display="block" pl={20} mt={2}>
          <CodeSpans text={row.state.line} />
        </Text>
      </UnstyledButton>
      {menu}
    </Group>
  );
}
