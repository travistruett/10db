import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
import { readSuggestionFiles } from './suggest';

describe('readSuggestionFiles', () => {
  let repo: TempDir;
  beforeEach(() => {
    repo = createTempRepo();
    writeFileSync(join(repo.path, '.env.production'), 'API_KEY=hunter2\n');
    writeFileSync(join(repo.path, 'summarize.py'), 'def summarize(): ...\n');
    const run = (...args: string[]): void => {
      execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });
    };
    run('add', '.env.production', 'summarize.py');
    run('commit', '-q', '-m', 'files');
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('never reads a committed secret file a gap names', async () => {
    const git = createGit({ worktreeRoot: join(repo.path, '..', 'unused') });
    const files = await readSuggestionFiles(git, repo.path, [
      '.env.production:3',
      'summarize.py:1',
    ]);
    expect(files.map((f) => f.path)).toEqual(['summarize.py']);
  });
});
