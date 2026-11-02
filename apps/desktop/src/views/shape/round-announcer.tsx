import { ShapeProposalState, type ShapeViewDto } from '@10db/contracts';
import { VisuallyHidden } from '@mantine/core';
import { useState } from 'react';

/** "Round 3: 4 changes": the rows the round created or changed (superseded ones move to Earlier). */
export function roundSummary(view: ShapeViewDto): string {
  const round = view.shape.round;
  const changes = view.proposals.filter(
    (p) => p.round === round && p.state !== ShapeProposalState.Rejected,
  ).length;
  return `Round ${String(round)}: ${String(changes)} ${changes === 1 ? 'change' : 'changes'}`;
}

/**
 * One polite live region that says a round's summary when a new round lands. It says nothing for the
 * round the screen opened on, and it never moves focus.
 */
export function RoundAnnouncer({ view }: { readonly view: ShapeViewDto | undefined }) {
  // The round last seen. The first view only sets the baseline; a later, higher round is announced.
  const [seen, setSeen] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const round = view?.shape.round ?? null;
  if (view !== undefined && round !== null && seen !== round) {
    setSeen(round);
    if (seen !== null && round > seen) setMessage(roundSummary(view));
  }
  return (
    <VisuallyHidden role="status" aria-live="polite" aria-label="Round summary">
      {message}
    </VisuallyHidden>
  );
}
