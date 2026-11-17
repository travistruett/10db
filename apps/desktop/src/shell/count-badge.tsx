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
  cap,
}: {
  readonly count: number;
  readonly tone?: CountTone;
  readonly phrase?: string;
  /** The largest count shown whole; above it the badge reads "99+" style. */
  readonly cap?: number;
}) {
  const attention = tone === CountTone.Attention;
  const shown = cap !== undefined && count > cap ? `${String(cap)}+` : count;
  return (
    <Badge
      size="xs"
      fw={600}
      px={5}
      miw={16}
      variant={attention ? 'filled' : 'light'}
      // An attention count takes the theme's primary colour, Badge's own default.
      {...(attention ? {} : { color: 'gray' })}
    >
      {phrase === undefined ? (
        shown
      ) : (
        <>
          {/* The name computation drops a leading space inside VisuallyHidden, so the number is hidden
              from assistive tech and the hidden text carries the whole phrase. */}
          <span aria-hidden="true">{shown}</span>
          <VisuallyHidden>{phrase}</VisuallyHidden>
        </>
      )}
    </Badge>
  );
}
