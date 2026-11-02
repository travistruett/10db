import type { WorkstreamState } from '@10db/contracts';
import { Badge } from '@mantine/core';
import { STATE_COLORS, STATE_LABELS } from './workstream-state';

export function StateBadge({ state }: { readonly state: WorkstreamState }) {
  return (
    <Badge
      color={STATE_COLORS[state]}
      variant="light"
      size="sm"
      // Mantine's badge root is an inline grid whose label span is `overflow: hidden` with an
      // ellipsis, so its minimum width is 0 and a table can squeeze it to "FAI…". `max-content` keeps
      // the pill as wide as its word; the label override drops the ellipsis as a second guard. A
      // state that can't be read defeats the column.
      style={{ minWidth: 'max-content' }}
      styles={{ label: { overflow: 'visible', textOverflow: 'clip' } }}
    >
      {STATE_LABELS[state]}
    </Badge>
  );
}
