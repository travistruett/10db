import { describe, expect, it } from 'vitest';
import {
  pageComposerPhase,
  pagePhase,
  PagePhase,
  type PageComposerPhase,
} from './page-composer-phase';
import { PageStatus } from './page-status';

const P = PagePhase;

/** What a phase shows: Sign Off, Send and Stop, without the words. */
const buttons = (p: PageComposerPhase) => ({
  signOff: p.signOff,
  send: p.phase.send,
  stop: p.phase.stop,
});

describe('pageComposerPhase', () => {
  it.each<{
    name: string;
    phase: PagePhase;
    hasContent: boolean;
    shows: ReturnType<typeof buttons>;
  }>([
    {
      name: 'ready and empty: Sign Off is the primary, Send hidden',
      phase: P.Ready,
      hasContent: false,
      shows: { signOff: 'filled', send: 'hidden', stop: null },
    },
    {
      name: 'ready with text: Send is the primary, Sign Off steps back',
      phase: P.Ready,
      hasContent: true,
      shows: { signOff: 'default', send: 'filled', stop: null },
    },
    {
      name: 'working and empty: a plain Stop, never disabled, and no Send',
      phase: P.Working,
      hasContent: false,
      shows: { signOff: null, send: 'hidden', stop: 'stop' },
    },
    {
      name: 'working with text: Send adds to the turn, Stop and Redo redoes with it',
      phase: P.Working,
      hasContent: true,
      shows: { signOff: null, send: 'filled', stop: 'stop_and_redo' },
    },
    {
      name: 'signing off: Send, which waits for words',
      phase: P.Signing,
      hasContent: false,
      shows: { signOff: null, send: 'filled', stop: null },
    },
    {
      name: 'any other page: Send, which waits for words',
      phase: P.Other,
      hasContent: true,
      shows: { signOff: null, send: 'filled', stop: null },
    },
  ])('$name', ({ phase, hasContent, shows }) => {
    expect(
      buttons(pageComposerPhase(phase, { hasContent, area: 'Settings', firstMessage: false })),
    ).toEqual(shows);
  });

  it('never has two filled buttons', () => {
    for (const phase of Object.values(P))
      for (const hasContent of [false, true]) {
        const b = buttons(pageComposerPhase(phase, { hasContent, area: 'S', firstMessage: false }));
        const filled = [b.signOff === 'filled', b.send === 'filled' && hasContent].filter(Boolean);
        expect(filled.length).toBeLessThanOrEqual(1);
      }
  });

  it.each([
    { phase: P.Working, firstMessage: false, says: 'Add to this turn…' },
    { phase: P.Ready, firstMessage: false, says: 'Reply, or paste a screenshot…' },
    {
      phase: P.Other,
      firstMessage: true,
      says: 'What should change on Settings? Paste a screenshot…',
    },
  ])('asks $says', ({ phase, firstMessage, says }) => {
    expect(
      pageComposerPhase(phase, { hasContent: false, area: 'Settings', firstMessage }).phase
        .placeholder,
    ).toBe(says);
  });
});

describe('pagePhase', () => {
  it.each<{ status: PageStatus; phase: PagePhase }>([
    { status: PageStatus.Ready, phase: P.Ready },
    { status: PageStatus.Working, phase: P.Working },
    { status: PageStatus.Paused, phase: P.Working },
    { status: PageStatus.SigningOff, phase: P.Signing },
    { status: PageStatus.Waiting, phase: P.Signing },
    { status: PageStatus.Asks, phase: P.Other },
    { status: PageStatus.Failed, phase: P.Other },
    { status: PageStatus.NotStarted, phase: P.Other },
    { status: PageStatus.SignedOff, phase: P.Other },
  ])('$status composes as $phase', ({ status, phase }) => {
    expect(pagePhase(status)).toBe(phase);
  });
});
