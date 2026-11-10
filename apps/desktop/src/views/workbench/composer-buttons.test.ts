import { describe, expect, it } from 'vitest';
import {
  composerButtons,
  composerPhase,
  ComposerPhase,
  type ComposerButtons,
} from './composer-buttons';
import { PageStatus } from './page-status';

const P = ComposerPhase;

describe('composerButtons', () => {
  it.each<{ name: string; phase: ComposerPhase; hasContent: boolean; buttons: ComposerButtons }>([
    {
      name: 'ready and empty: Sign Off is the primary, Send hidden',
      phase: P.Ready,
      hasContent: false,
      buttons: { signOff: 'filled', send: null, stop: null },
    },
    {
      name: 'ready with text: Send is the primary, Sign Off steps back',
      phase: P.Ready,
      hasContent: true,
      buttons: { signOff: 'default', send: { variant: 'filled', enabled: true }, stop: null },
    },
    {
      name: 'working and empty: a plain Stop, never disabled, and no Send',
      phase: P.Working,
      hasContent: false,
      buttons: { signOff: null, send: null, stop: 'stop' },
    },
    {
      name: 'working with text: Send adds to the turn, Stop and Redo redoes with it',
      phase: P.Working,
      hasContent: true,
      buttons: { signOff: null, send: { variant: 'filled', enabled: true }, stop: 'redo' },
    },
    {
      name: 'signing off and empty: Send waits for words',
      phase: P.Signing,
      hasContent: false,
      buttons: { signOff: null, send: { variant: 'filled', enabled: false }, stop: null },
    },
    {
      name: 'signing off with text: Send',
      phase: P.Signing,
      hasContent: true,
      buttons: { signOff: null, send: { variant: 'filled', enabled: true }, stop: null },
    },
    {
      name: 'any other page and empty: Send waits for words',
      phase: P.Other,
      hasContent: false,
      buttons: { signOff: null, send: { variant: 'filled', enabled: false }, stop: null },
    },
    {
      name: 'any other page with text: Send',
      phase: P.Other,
      hasContent: true,
      buttons: { signOff: null, send: { variant: 'filled', enabled: true }, stop: null },
    },
  ])('$name', ({ phase, hasContent, buttons }) => {
    expect(composerButtons(phase, hasContent)).toEqual(buttons);
  });

  it('never has two filled buttons', () => {
    for (const phase of Object.values(P))
      for (const hasContent of [false, true]) {
        const b = composerButtons(phase, hasContent);
        const filled = [b.signOff === 'filled', b.send?.variant === 'filled'].filter(Boolean);
        expect(filled.length).toBeLessThanOrEqual(1);
      }
  });
});

describe('composerPhase', () => {
  it.each<{ status: PageStatus; phase: ComposerPhase }>([
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
    expect(composerPhase(status)).toBe(phase);
  });
});
