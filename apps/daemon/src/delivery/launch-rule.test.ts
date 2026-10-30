import { mintId, type BatchDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchLaunchVerdict } from './index';

const AT = '2026-10-21T12:00:00.000Z';
const batch = (overrides: Partial<BatchDto>): BatchDto => ({
  id: mintId('Batch'),
  projectId: mintId('Project'),
  title: 'Greetings',
  state: 'OPEN',
  branch: '10db/greetings-0a1b2c3d',
  baseBranch: 'main',
  autoMerge: true,
  baseSha: 'a'.repeat(40),
  repo: 'acme/widgets',
  prUrl: null,
  pr: null,
  gateExitCode: null,
  gateLogPath: null,
  failure: null,
  worktreePath: null,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

describe('batchLaunchVerdict', () => {
  it.each<{ name: string; batch: BatchDto | null; current: string | null; expected: string }>([
    { name: 'no batch', batch: null, current: 'main', expected: 'wait' },
    {
      name: 'a cutting batch',
      batch: batch({ state: 'CUTTING', branch: null, baseSha: null }),
      current: 'main',
      expected: 'wait',
    },
    {
      name: 'an open batch with no base yet',
      batch: batch({ baseSha: null }),
      current: '10db/greetings-0a1b2c3d',
      expected: 'wait',
    },
    {
      name: 'an open batch on its branch',
      batch: batch({}),
      current: '10db/greetings-0a1b2c3d',
      expected: 'launch',
    },
    {
      name: 'an open batch on another branch',
      batch: batch({}),
      current: 'main',
      expected: 'wrong_branch',
    },
    {
      name: 'an open batch on a detached HEAD',
      batch: batch({}),
      current: null,
      expected: 'wrong_branch',
    },
    {
      name: 'a failed batch on its branch',
      batch: batch({ state: 'FAILED' }),
      current: '10db/greetings-0a1b2c3d',
      expected: 'wait',
    },
    {
      name: 'a shipping batch on its branch',
      batch: batch({ state: 'SHIPPING' }),
      current: '10db/greetings-0a1b2c3d',
      expected: 'wait',
    },
  ])('$name: $expected', ({ batch: b, current, expected }) => {
    expect(batchLaunchVerdict(b, current)).toBe(expected);
  });
});
