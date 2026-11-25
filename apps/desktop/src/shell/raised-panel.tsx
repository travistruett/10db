import { Paper } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * A page's table or chart as one raised thing (DESIGN.md, Elevation). A table inside sits flat and flush
 * on it, clipped to its corners; a chart takes `padded`.
 */
export function RaisedPanel({
  children,
  padded = false,
}: {
  readonly children: ReactNode;
  readonly padded?: boolean;
}) {
  return padded ? (
    <Paper variant="raised" radius="md" p="sm">
      {children}
    </Paper>
  ) : (
    <Paper variant="raised" radius="md" style={{ overflow: 'hidden' }}>
      {children}
    </Paper>
  );
}
