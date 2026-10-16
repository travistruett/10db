import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTempRepo } from './fixtures';

describe('createTempRepo', () => {
  it('makes a git repository with one commit on main and removes it on cleanup', () => {
    const repo = createTempRepo();
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo.path, ...args], { encoding: 'utf8' }).trim();
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
    repo.cleanup();
    expect(existsSync(repo.path)).toBe(false);
  });
});
