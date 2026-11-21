import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { anotherWritersRound, FREE_LEFT_ROUNDS } from './start-dirt';

describe('anotherWritersRound', () => {
  const session = mintId('Session');
  const left = {
    path: 'theirs.txt',
    fingerprint: null,
    leftBy: mintId('Deviation'),
    leftIn: session,
  };
  const round: Parameters<typeof anotherWritersRound>[0] = {
    previous: ['theirs.txt'],
    paths: ['new.txt'],
    record: [left],
    lastSession: session,
    leaves: 1,
  };

  it('spares only new paths after a session that named some, for a bounded number of leaves', () => {
    const rows: [string, Partial<typeof round>, boolean][] = [
      ['new paths after a leave', {}, true],
      ['a path sent back before', { paths: ['theirs.txt', 'new.txt'] }, false],
      ['no send-back before it', { previous: null }, false],
      ['a session that named nothing', { lastSession: mintId('Session') }, false],
      ['the last free round', { leaves: FREE_LEFT_ROUNDS }, true],
      // Naming the same path again replaces its record entry, but each call still counts.
      ['past the rounds', { leaves: FREE_LEFT_ROUNDS + 1 }, false],
    ];
    for (const [name, change, free] of rows)
      expect.soft(anotherWritersRound({ ...round, ...change }), name).toBe(free);
  });
});
