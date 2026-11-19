import { Group, Text, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';
import { StatusDot } from '../factory/status-dot';
import type { QueueRow as Row } from './queue-rows';
import { CodeSpans } from '../../shell/code-spans';
import classes from './queue-row.module.css';

export interface QueueRowProps {
  readonly row: Row;
  readonly current: boolean;
  readonly onSelect: () => void;
  /** The row's menu, drawn beside its button; null when the row has none. */
  readonly menu: ReactNode;
}

/**
 * One page of the queue, drawn as an Inbox row: a status dot, the page's name, heavier when it waits on the
 * builder, and its state line under the name. A hairline parts it from the next; the page shown is on the
 * selected fill; its menu shows on hover, on the shown row and with focus; a row that needs nothing is dimmed.
 */
export function QueueRow({ row, current, onSelect, menu }: QueueRowProps) {
  return (
    <div className={classes['item']} data-current={current ? '' : undefined}>
      <UnstyledButton
        className={classes['button']}
        aria-current={current ? 'true' : undefined}
        {...(row.dimmed ? { c: 'dimmed' } : {})}
        onClick={(event) => {
          // A pointer click hands the cursor on to the page's composer, as WebKit does by never
          // focusing the button; Enter on a focused row (detail 0) keeps it here for J and K.
          if (event.detail > 0) event.currentTarget.blur();
          onSelect();
        }}
      >
        <Group gap="sm" wrap="nowrap" align="center">
          <StatusDot color={row.state.color} />
          <Text
            component="span"
            size="sm"
            fw={row.state.needsYou ? 500 : 400}
            {...(row.dimmed ? {} : { c: 'var(--mantine-color-bright)' })}
            truncate="end"
            style={{ minWidth: 0 }}
          >
            {row.page.label}
          </Text>
        </Group>
        {/* The state goes under the name, beside the dot's column, so it has the row's width and wraps
            there: "Working · 4 min · median 6" outgrows the queue beside a name. */}
        <Text component="span" size="xs" c="dimmed" display="block" pl={20} mt={4}>
          <CodeSpans text={row.state.line} />
        </Text>
      </UnstyledButton>
      {menu === null ? null : <div className={classes['menu']}>{menu}</div>}
    </div>
  );
}
