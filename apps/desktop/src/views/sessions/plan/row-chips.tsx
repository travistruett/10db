import type { ShapeFindingSeverity } from '@10db/contracts';
import { Badge } from '@mantine/core';
import { IconPin } from '@tabler/icons-react';
import { SEVERITY_COLOR } from './review-lines';

/** What a row's chips say; each part is left out when it has nothing to say. */
export interface RowChipFacts {
  /** The size bucket, or another short fact such as a decision's scope. */
  readonly meta?: string | undefined;
  readonly findings?: { readonly count: number; readonly severity: ShapeFindingSeverity | null };
  readonly questions?: number;
  readonly mockup?: 'approved' | 'waiting' | null;
  readonly pinned?: boolean;
}

const plural = (n: number, one: string): string => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

const chip = { size: 'xs', variant: 'light', tt: 'none', fw: 400 } as const;

/** The small facts at a row's right: size, findings (in their highest severity's color), questions and mock-up. */
export function RowChips({ facts }: { readonly facts: RowChipFacts }) {
  const { meta, findings, questions = 0, mockup = null, pinned = false } = facts;
  return (
    <>
      {pinned ? (
        <IconPin
          size={14}
          stroke={1.5}
          role="img"
          aria-label="Pinned"
          color="var(--mantine-color-dimmed)"
        />
      ) : null}
      {findings === undefined || findings.count === 0 ? null : (
        <Badge
          {...chip}
          color={findings.severity === null ? 'gray' : SEVERITY_COLOR[findings.severity]}
        >
          {plural(findings.count, 'finding')}
        </Badge>
      )}
      {questions === 0 ? null : (
        <Badge {...chip} color="violet">
          {plural(questions, 'question')}
        </Badge>
      )}
      {mockup === null ? null : (
        <Badge {...chip} color={mockup === 'approved' ? 'green' : 'gray'}>
          {mockup === 'approved' ? 'mock-up ✓' : 'mock-up'}
        </Badge>
      )}
      {meta === undefined || meta === '' ? null : (
        <Badge {...chip} color="gray">
          {meta}
        </Badge>
      )}
    </>
  );
}
