import { Box, Paper } from '@mantine/core';
import type { ReactNode } from 'react';
import { SELECTED_CARD_ATTRIBUTE } from './use-inbox-keys';

/**
 * What a card draws on: its own bordered paper where a card stands alone, or the plain content area where
 * the Inbox's panel already says which card it is. `selected` marks it as the card the Inbox keys act on.
 */
export function CardSurface({
  framed,
  selected = false,
  children,
}: {
  readonly framed: boolean;
  readonly selected?: boolean;
  readonly children: ReactNode;
}) {
  const marker = selected ? { [SELECTED_CARD_ATTRIBUTE]: true } : {};
  if (framed)
    return (
      <Paper withBorder p="md" shadow="xs" {...marker}>
        {children}
      </Paper>
    );
  return <Box {...marker}>{children}</Box>;
}
