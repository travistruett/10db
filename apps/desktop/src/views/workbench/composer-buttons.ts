import { PageStatus } from './page-status';

// Workbench spec §4.3, design review D14: the buttons beside a page's composer. DESIGN.md allows one
// filled primary per group. Open Page is always a default button on the left and is not in this table.
// Stop and Redo is never disabled: with an empty composer it is a plain Stop.

/** Where a page is, as its composer's buttons read it. */
export const ComposerPhase = {
  Ready: 'ready',
  /** A turn works, or is paused by a usage limit: Stop and Redo can end it. */
  Working: 'working',
  /** Signing off, or waiting to: no turn to stop and nothing to sign off again. */
  Signing: 'signing',
  Other: 'other',
} as const;
export type ComposerPhase = (typeof ComposerPhase)[keyof typeof ComposerPhase];

export type ButtonVariant = 'filled' | 'default';

export interface ComposerButtons {
  /** Sign Off, or null when hidden. */
  readonly signOff: ButtonVariant | null;
  /** Send, or null when hidden; shown but disabled while there is nothing to send. */
  readonly send: { readonly variant: ButtonVariant; readonly enabled: boolean } | null;
  /** What Stop and Redo does, or null when hidden: `stop` with nothing typed, `redo` with the text. */
  readonly stop: 'stop' | 'redo' | null;
}

const PHASE: Readonly<Record<PageStatus, ComposerPhase>> = {
  [PageStatus.Ready]: ComposerPhase.Ready,
  [PageStatus.Working]: ComposerPhase.Working,
  [PageStatus.Paused]: ComposerPhase.Working,
  [PageStatus.SigningOff]: ComposerPhase.Signing,
  [PageStatus.Waiting]: ComposerPhase.Signing,
  [PageStatus.Asks]: ComposerPhase.Other,
  [PageStatus.Failed]: ComposerPhase.Other,
  [PageStatus.NotStarted]: ComposerPhase.Other,
  [PageStatus.SignedOff]: ComposerPhase.Other,
};

export function composerPhase(status: PageStatus): ComposerPhase {
  return PHASE[status];
}

/** The composer's buttons for a page in `phase`, with or without something typed or pasted. */
export function composerButtons(phase: ComposerPhase, hasContent: boolean): ComposerButtons {
  const send = { variant: 'filled', enabled: hasContent } as const;
  switch (phase) {
    case ComposerPhase.Ready:
      return hasContent
        ? { signOff: 'default', send, stop: null }
        : { signOff: 'filled', send: null, stop: null };
    case ComposerPhase.Working:
      return hasContent
        ? { signOff: null, send, stop: 'redo' }
        : { signOff: null, send: null, stop: 'stop' };
    case ComposerPhase.Signing:
    case ComposerPhase.Other:
      return { signOff: null, send, stop: null };
  }
}
