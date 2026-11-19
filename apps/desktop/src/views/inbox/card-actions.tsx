import { Group } from '@mantine/core';
import type { ReactNode } from 'react';
import classes from './card-actions.module.css';

/**
 * A card's buttons. Where the card stands alone they end it; in the Inbox's content they are a bar held at the
 * pane's foot, so Dismiss and Send Answer stay in one place however long the card is.
 */
export function CardActions({
  framed,
  start = null,
  children,
}: {
  readonly framed: boolean;
  /** What sits at the bar's left, such as a failure's words. */
  readonly start?: ReactNode;
  readonly children: ReactNode;
}) {
  if (framed)
    return (
      <Group justify={start === null ? 'flex-end' : 'space-between'} wrap="nowrap">
        {start}
        <Group justify="flex-end">{children}</Group>
      </Group>
    );
  return (
    <div className={classes['bar']}>
      <div className={classes['start']}>{start}</div>
      <Group justify="flex-end" gap="sm" wrap="nowrap">
        {children}
      </Group>
    </div>
  );
}
