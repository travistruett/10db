import { Group } from '@mantine/core';
import type { ReactNode } from 'react';
import classes from './card-actions.module.css';

/**
 * A card's buttons. Where the card stands alone they end it; in the Inbox's content they are a bar held at the
 * pane's foot, so Dismiss and Send Answer stay in one place however long the card is.
 */
export function CardActions({
  framed,
  children,
}: {
  readonly framed: boolean;
  readonly children: ReactNode;
}) {
  if (framed)
    return (
      <Group justify="flex-end" mt="sm">
        {children}
      </Group>
    );
  return (
    <div className={classes['bar']}>
      <Group justify="flex-end" gap="sm">
        {children}
      </Group>
    </div>
  );
}
