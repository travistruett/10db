import { Text, Tooltip } from '@mantine/core';
import { IconMessage, IconPin } from '@tabler/icons-react';
import classes from './plan-rows.module.css';

/** What a row's chips say; each part is left out when it has nothing to say. */
export interface RowChipFacts {
  /** The round's mark in words ("New", "Changed", "Moved to Earlier"), after its dot's colour when it has one. */
  readonly mark?: {
    readonly text: string;
    readonly kind: string;
    readonly dot?: string | null;
  } | null;
  /** What the row is when its card names something else: "Added", "Principle", "Removal". */
  readonly kind?: string | null;
  /** The spec the row's ceremony asks for. */
  readonly spec?: boolean;
  /** Findings and questions together. */
  readonly notes?: number;
  readonly pinned?: boolean;
}

const plural = (n: number, one: string): string => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

/** The small dim facts at a row's right, no color: the round's mark, kind, spec and pin in words, and notes as an icon and a count. */
export function RowChips({ facts }: { readonly facts: RowChipFacts }) {
  const { mark = null, kind = null, spec = false, notes = 0, pinned = false } = facts;
  return (
    <>
      {mark === null ? null : (
        <Text span fz={12} c="dimmed" data-mark={mark.kind} className={classes['mark']}>
          {mark.dot === undefined || mark.dot === null ? null : (
            <span
              className={classes['markDot']}
              style={{ background: `var(--mantine-color-${mark.dot}-filled)` }}
              aria-hidden="true"
            />
          )}
          {mark.text}
        </Text>
      )}
      {kind === null ? null : (
        <Text span fz={12} c="dimmed">
          {kind}
        </Text>
      )}
      {spec ? (
        <Text span fz={12} c="dimmed">
          Spec required
        </Text>
      ) : null}
      {pinned ? (
        <IconPin
          size={14}
          stroke={1.5}
          role="img"
          aria-label="Pinned"
          color="var(--mantine-color-dimmed)"
        />
      ) : null}
      {notes === 0 ? null : (
        <Tooltip label={plural(notes, 'note')}>
          <Text
            span
            fz={12}
            c="dimmed"
            role="img"
            aria-label={plural(notes, 'note')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
          >
            <IconMessage size={14} stroke={1.5} aria-hidden="true" />
            {notes}
          </Text>
        </Tooltip>
      )}
    </>
  );
}
