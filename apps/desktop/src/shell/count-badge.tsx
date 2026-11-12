import { Badge } from '@mantine/core';

/**
 * A count beside a control's label, put in the control's `rightSection`. A label never carries its
 * count in parentheses (DESIGN.md, Counts).
 */
export function CountBadge({ count }: { readonly count: number }) {
  return (
    <Badge size="sm" variant="filled" circle={count < 10}>
      {count}
    </Badge>
  );
}
