import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { matchesGlob } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedGitEnv } from '../../test/fixtures';
import { createGit } from '../git';
import { proposeAreas } from './propose-areas';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');

describe('the areas proposed for this repository', () => {
  it('separate the desktop app, the daemon and each package, and cover every tracked file', async () => {
    const result = await proposeAreas({ git: createGit(), namer: null, protectedRoots: [] }, REPO);
    if (!result.ok) throw new Error(result.message);
    const { areas } = result.proposal;
    const owning = (glob: string) => areas.filter((a) => a.globs.includes(glob));
    for (const unit of [
      'apps/daemon',
      'apps/desktop',
      'packages/contracts',
      'packages/db',
      'packages/harness',
    ])
      expect(owning(`${unit}/**`), unit).toHaveLength(1);
    const named = [
      'apps/daemon/**',
      'apps/desktop/**',
      'packages/contracts/**',
      'packages/db/**',
      'packages/harness/**',
    ].map((g) => owning(g)[0]?.name);
    expect(new Set(named).size).toBe(named.length);
    for (const area of areas) expect(area.globs.length, area.name).toBeGreaterThan(0);

    const tracked = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { env: isolatedGitEnv() })
      .toString()
      .split('\0')
      .filter((f) => f !== '');
    const uncovered = tracked.filter(
      (f) => !areas.some((a) => a.globs.some((g) => matchesGlob(f, g))),
    );
    expect(uncovered).toEqual([]);
  });
});
