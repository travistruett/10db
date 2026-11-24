import { Group } from '@mantine/core';
import type { ReactNode } from 'react';
import classes from './card-actions.module.css';

/**
 * A card's note and buttons. Where the card stands alone they end it; in the Inbox's content they are a bar
 * held at the pane's foot, so the note, Dismiss and Send Answer stay in one place however long the card is.
 */
export function CardActions({
  framed,
  note = null,
  children,
}: {
  readonly framed: boolean;
  /** The answer's note field, at the bar's left and taking the room the buttons leave. */
  readonly note?: ReactNode;
  readonly children: ReactNode;
}) {
  const row = (
    <Group justify="flex-end" align="flex-end" gap="sm" wrap="nowrap">
      {note === null ? null : <div style={{ flex: 1, minWidth: 0 }}>{note}</div>}
      {children}
    </Group>
  );
  if (framed) return <div style={{ marginTop: 'var(--mantine-spacing-sm)' }}>{row}</div>;
  return <div className={classes['bar']}>{row}</div>;
}
