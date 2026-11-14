import { Paper } from '@mantine/core';
import type { ReactNode } from 'react';

/** A bordered block on the raised tone, so a page's tables and charts stand off its body. */
export function RaisedPanel({ children }: { readonly children: ReactNode }) {
  return (
    <Paper withBorder radius="md" p="sm" bg="var(--tendb-color-panel)">
      {children}
    </Paper>
  );
}
