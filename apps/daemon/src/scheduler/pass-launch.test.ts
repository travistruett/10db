import { describe, expect, it } from 'vitest';
import { passLaunch, PassLaunch, type PassLaunchFacts } from './pass-launch';

// Workbench spec §5.5, §6.2, §12: a queued page runs on its rows (an untaken builder message, an open
// turn), whatever next action a crash, a pause or a taken message left behind.

const quiet: PassLaunchFacts = {
  passState: 'OPEN',
  takingOut: false,
  untaken: false,
  turnOpen: false,
  folderOn: true,
};

describe('passLaunch', () => {
  it.each<{ name: string; facts: Partial<PassLaunchFacts>; verdict: PassLaunch }>([
    { name: 'a page nobody has written to', facts: {}, verdict: PassLaunch.Idle },
    {
      name: "the builder's first message",
      facts: { untaken: true },
      verdict: PassLaunch.Launch,
    },
    {
      name: 'a message pushed to a session that ended before a turn took it',
      facts: { untaken: true, turnOpen: true },
      verdict: PassLaunch.Launch,
    },
    {
      name: 'a turn a crash cut short, its message taken (twice over: still the open turn)',
      facts: { turnOpen: true },
      verdict: PassLaunch.Launch,
    },
    {
      name: 'a page stopped and then being taken out',
      facts: { untaken: true, takingOut: true },
      verdict: PassLaunch.TakingOut,
    },
    {
      name: 'a message to a page of a pass being abandoned',
      facts: { untaken: true, passState: 'ABANDONING' },
      verdict: PassLaunch.PassNotOpen,
    },
    {
      name: 'a message to a page of a pass being closed',
      facts: { untaken: true, passState: 'CLOSING' },
      verdict: PassLaunch.PassNotOpen,
    },
    {
      name: 'a message while the folder is on another branch',
      facts: { untaken: true, folderOn: false },
      verdict: PassLaunch.FolderOff,
    },
    {
      name: 'an open turn while the folder is on another branch',
      facts: { turnOpen: true, folderOn: false },
      verdict: PassLaunch.FolderOff,
    },
    {
      name: 'a message before this tick read the folder',
      facts: { untaken: true, folderOn: null },
      verdict: PassLaunch.FolderOff,
    },
  ])('$name: $verdict', ({ facts, verdict }) => {
    expect(passLaunch({ ...quiet, ...facts })).toBe(verdict);
  });
});
