import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestStore, seedProject } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { startFacts } from './start-facts';

// UI spec §6.2: Start from's facts, read from a real repository with an injected clock.

const NOW = new Date('2026-11-13T12:00:00.000Z');

let repo: TempDir;
let close: () => void;
afterEach(() => {
  repo.cleanup();
  close();
});

describe('startFacts', () => {
  it("counts the base's commits of the last day and names the area the latest commit touched", async () => {
    repo = createTempRepo();
    const git = (env: Record<string, string>, ...args: string[]) =>
      execFileSync('git', ['-C', repo.path, ...args], {
        env: { ...isolatedGitEnv(), ...env },
        stdio: 'pipe',
      });
    const commitAt = (date: string, file: string) => {
      mkdirSync(join(repo.path, file, '..'), { recursive: true });
      writeFileSync(join(repo.path, file), `${file}\n`);
      git({}, 'add', file);
      git({ GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }, 'commit', '-q', '-m', file);
    };
    commitAt('2026-11-10T12:00:00Z', 'docs/old.md');
    commitAt('2026-11-13T11:00:00Z', 'src/billing/charge.ts');
    const test = createTestStore();
    close = test.close;
    const project = seedProject(test.store, {
      repoPath: repo.path,
      areas: [
        { name: 'billing', globs: ['src/billing/**'] },
        { name: 'repo', globs: ['**'] },
      ],
    });
    const facts = await startFacts(
      {
        db: test.store.db,
        git: (cwd, args) =>
          Promise.resolve(
            execFileSync('git', ['-C', cwd, ...args], { env: isolatedGitEnv(), encoding: 'utf8' }),
          ),
      },
      project,
      NOW,
    );
    expect(facts).toEqual({
      failedTask: null,
      baseCommits: { base: 'main', count: 1 },
      recentArea: 'billing',
    });
  });
});
