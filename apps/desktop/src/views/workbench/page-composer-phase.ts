import type { ComposerPhase } from '../../conversation/composer-phase';
import { PageStatus } from './page-status';

// Workbench spec §4.3, design review D14: the pass's phase table, what the kit's composer shows beside
// a page's input, and Commit's variant in the page's title row. DESIGN.md allows one filled primary per
// group. Open in Browser is always a default button and is not in this table. Stop and Redo is never disabled: with an empty composer it is a
// plain Stop.

/** Where a page is, as its composer reads it. */
export const PagePhase = {
  Ready: 'ready',
  /** A turn works, or is paused by a usage limit: Stop and Redo can end it. */
  Working: 'working',
  /** Signing off, or waiting to: no turn to stop and nothing to commit again. */
  Signing: 'signing',
  Other: 'other',
} as const;
export type PagePhase = (typeof PagePhase)[keyof typeof PagePhase];

const PHASE: Readonly<Record<PageStatus, PagePhase>> = {
  [PageStatus.Ready]: PagePhase.Ready,
  [PageStatus.PreviewBroken]: PagePhase.Ready,
  [PageStatus.Working]: PagePhase.Working,
  [PageStatus.Paused]: PagePhase.Working,
  [PageStatus.SigningOff]: PagePhase.Signing,
  [PageStatus.Waiting]: PagePhase.Signing,
  [PageStatus.Asks]: PagePhase.Other,
  [PageStatus.Failed]: PagePhase.Other,
  [PageStatus.NotStarted]: PagePhase.Other,
  [PageStatus.SignedOff]: PagePhase.Other,
};

export function pagePhase(status: PageStatus): PagePhase {
  return PHASE[status];
}

/** A page's composer: the kit's phase, and Commit's variant, or null when it is hidden. */
export interface PageComposerPhase {
  readonly phase: ComposerPhase;
  readonly commit: 'filled' | 'default' | null;
}

function placeholder(label: string, phase: PagePhase, firstMessage: boolean): string {
  if (firstMessage) return `What should change on ${label}? Paste a screenshot…`;
  return phase === PagePhase.Working ? 'Add to this turn…' : 'Reply, or paste a screenshot…';
}

/**
 * The composer of a page in `phase`, with or without something typed or pasted, and with or without
 * picks from its Preview. Send shows, disabled until there is something to send, wherever the table
 * neither hides it nor makes Commit the primary. Picks come from a page that runs agent-written code,
 * so they never turn Stop into Stop and Redo (Pick on Page spec §4): only the builder's own words and
 * pictures do.
 */
export function pageComposerPhase(
  phase: PagePhase,
  input: {
    readonly typed: boolean;
    readonly picks: boolean;
    readonly label: string;
    readonly firstMessage: boolean;
  },
): PageComposerPhase {
  const base = { placeholder: placeholder(input.label, phase, input.firstMessage), hint: null };
  const { typed, picks } = input;
  switch (phase) {
    case PagePhase.Ready:
      return typed || picks
        ? { phase: { ...base, stop: null, send: 'filled' }, commit: 'default' }
        : { phase: { ...base, stop: null, send: 'hidden' }, commit: 'filled' };
    case PagePhase.Working:
      if (typed) return { phase: { ...base, stop: 'stop_and_redo', send: 'filled' }, commit: null };
      return picks
        ? { phase: { ...base, stop: 'stop', send: 'filled' }, commit: null }
        : { phase: { ...base, stop: 'stop', send: 'hidden' }, commit: null };
    case PagePhase.Signing:
    case PagePhase.Other:
      return { phase: { ...base, stop: null, send: 'filled' }, commit: null };
  }
}
