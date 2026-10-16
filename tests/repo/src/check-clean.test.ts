import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createThrowawayRepo, type ThrowawayRepo } from './fixtures';
import { repoRoot } from './workspace';

const SCRIPT = resolve(repoRoot, 'scripts/check-clean.sh');

describe('scripts/check-clean.sh', () => {
  let repo: ThrowawayRepo;
  // Writes without staging, so a row can leave an edit or a new file out of the index.
  const write = (path: string, text: string) => {
    writeFileSync(join(repo.dir, path), text);
  };
  // /bin/bash, not bash from PATH: macOS ships bash 3.2 there, and the script must run on it.
  const check = () =>
    spawnSync('/bin/bash', [SCRIPT, 'gen'], { cwd: repo.dir, env: repo.env, encoding: 'utf8' });

  beforeEach(() => {
    repo = createThrowawayRepo('10db-check-clean');
    repo.stage('gen/a.json', '1\n');
    repo.commit('chore(repo): init');
  });

  afterEach(() => {
    repo.remove();
  });

  it.each<[string, () => void, number]>([
    ['nothing changed', () => undefined, 0],
    [
      'a regenerated file is staged',
      () => {
        repo.stage('gen/a.json', '2\n');
      },
      0,
    ],
    [
      'a new generated file is staged',
      () => {
        repo.stage('gen/b.json', '1\n');
      },
      0,
    ],
    [
      'a generated file has unstaged edits',
      () => {
        write('gen/a.json', '2\n');
      },
      1,
    ],
    [
      'a staged file was regenerated again',
      () => {
        repo.stage('gen/a.json', '2\n');
        write('gen/a.json', '3\n');
      },
      1,
    ],
    [
      'a generated file is untracked',
      () => {
        write('gen/b.json', '1\n');
      },
      1,
    ],
    [
      'a generated file was deleted',
      () => {
        rmSync(join(repo.dir, 'gen/a.json'));
      },
      1,
    ],
  ])('%s', (_name, change, expected) => {
    change();
    const result = check();
    expect(result.status, result.stdout).toBe(expected);
  });
});
