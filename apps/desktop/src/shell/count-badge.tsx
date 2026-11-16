import { Badge, VisuallyHidden } from '@mantine/core';

export const CountTone = { Neutral: 'neutral', Attention: 'attention' } as const;
export type CountTone = (typeof CountTone)[keyof typeof CountTone];

/**
 * A count beside a control's label, put in the control's `rightSection`. A label never carries its
 * count in parentheses (DESIGN.md, Counts). It is a pill no taller than the label's text: muted by
 * default, and primary only when `tone` is `attention`, for what needs the builder. A `phrase` is what
 * assistive tech reads in place of the bare number.
 */
export function CountBadge({
  count,
  tone = CountTone.Neutral,
  phrase,
}: {
  readonly count: number;
  readonly tone?: CountTone;
  readonly phrase?: string;
}) {
  const attention = tone === CountTone.Attention;
  return (
    <Badge
      size="xs"
      fw={600}
      px={5}
      miw={16}
      variant={attention ? 'filled' : 'light'}
      color={attention ? 'blue' : 'gray'}
    >
      {phrase === undefined ? (
        count
      ) : (
        <>
          {/* The name computation drops a leading space inside VisuallyHidden, so the number is hidden
              from assistive tech and the hidden text carries the whole phrase. */}
          <span aria-hidden="true">{count}</span>
          <VisuallyHidden>{phrase}</VisuallyHidden>
        </>
      )}
    </Badge>
  );
}
