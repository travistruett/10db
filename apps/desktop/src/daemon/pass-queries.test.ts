import { mintId, type PassState } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { passViewDto } from '../test/pass-fixtures';
import { livePassOf } from './pass-queries';

describe('livePassOf', () => {
  const project = mintId('Project');
  const pass = (name: string, state: PassState, openedAt: string, projectId = project) =>
    passViewDto({ pass: { name, state, openedAt, projectId }, pages: [] });

  it.each<{ name: string; passes: ReturnType<typeof pass>[]; shown: string | null }>([
    { name: 'no live pass', passes: [], shown: null },
    {
      name: "another project's pass only",
      passes: [pass('Theirs', 'OPEN', '2026-11-09T12:00:00.000Z', mintId('Project'))],
      shown: null,
    },
    {
      name: 'a pass opened on a closed one still waiting for its merge',
      passes: [
        pass('Closed', 'CLOSED', '2026-11-09T10:00:00.000Z'),
        pass('Open', 'OPEN', '2026-11-09T09:00:00.000Z'),
      ],
      shown: 'Open',
    },
    {
      name: 'a pass abandoning, which still holds its pages',
      passes: [
        pass('Closed', 'CLOSED', '2026-11-09T10:00:00.000Z'),
        pass('Leaving', 'ABANDONING', '2026-11-09T09:00:00.000Z'),
      ],
      shown: 'Leaving',
    },
    {
      name: 'closed passes waiting to settle: the latest',
      passes: [
        pass('Older', 'CLOSED', '2026-11-08T10:00:00.000Z'),
        pass('Newer', 'CLOSED', '2026-11-09T10:00:00.000Z'),
      ],
      shown: 'Newer',
    },
  ])('$name', ({ passes, shown }) => {
    expect(livePassOf(passes, project)?.pass.name ?? null).toBe(shown);
  });
});
