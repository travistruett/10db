import type { WorkstreamState } from '@10db/contracts';
import { Badge } from '@mantine/core';
import { STATE_COLORS, STATE_LABELS } from './workstream-state';

export function StateBadge({ state }: { readonly state: WorkstreamState }) {
  return (
    <Badge
      color={STATE_COLORS[state]}
      variant="light"
      size="sm"
      // Mantine clips a badge to an ellipsis, and an `overflow: hidden` box lets a table squeeze it
      // to nothing; a state that can't be read defeats the column.
      style={{ overflow: 'visible', textOverflow: 'clip', whiteSpace: 'nowrap' }}
    >
      {STATE_LABELS[state]}
    </Badge>
  );
}
