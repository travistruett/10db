import type { WorkstreamState } from '@10db/contracts';
import { Badge } from '@mantine/core';
import { STATE_COLORS, STATE_LABELS } from './workstream-state';

export function StateBadge({ state }: { readonly state: WorkstreamState }) {
  return (
    <Badge color={STATE_COLORS[state]} variant="light" size="sm">
      {STATE_LABELS[state]}
    </Badge>
  );
}
