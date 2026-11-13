import { Badge } from '@mantine/core';
import type { AnchorStatus } from './anchor-status';

/** One anchor check's word in its color; the line or note is its title. */
export function AnchorBadge({ status }: { readonly status: AnchorStatus }) {
  return (
    <Badge size="sm" variant="light" color={status.color} title={status.detail ?? undefined}>
      {status.label}
    </Badge>
  );
}
