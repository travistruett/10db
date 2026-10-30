import { describe, expect, it } from 'vitest';
import { batchDto } from '../../../test/fixtures';
import { closeNote } from './close-note';

describe('closeNote', () => {
  it.each([
    {
      name: 'a branch with its worktree',
      batch: batchDto({ branch: '10db/areas-0a1b2c3d', worktreePath: '/tmp/wt' }),
      line: 'Close keeps the branch 10db/areas-0a1b2c3d and its worktree as they are.',
    },
    {
      name: 'a branch in the shared checkout',
      batch: batchDto({ branch: '10db/areas-0a1b2c3d', worktreePath: null }),
      line: 'Close keeps the branch 10db/areas-0a1b2c3d as it is.',
    },
    {
      name: 'a batch whose branch was never cut',
      batch: batchDto({ branch: null, worktreePath: null }),
      line: 'Close leaves any branch or worktree the run made as it is.',
    },
    {
      name: 'no batch at all',
      batch: undefined,
      line: 'Close leaves any branch or worktree the run made as it is.',
    },
  ])('says what happens to $name', ({ batch, line }) => {
    expect(closeNote(batch)).toBe(line);
  });
});
