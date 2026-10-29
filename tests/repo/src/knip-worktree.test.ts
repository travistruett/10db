import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envWithoutGitVariables, isolatedGitEnvironment } from './fixtures';
import { repoRoot } from './workspace';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KnipConfig = z.object({ lefthook: z.unknown().optional() });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: isolatedGitEnvironment(), stdio: 'pipe' });
}

/** A repository with a lefthook config and a linked worktree of it, as 10db cuts for a task. */
function linkedWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), '10db-knip-'));
  cleanup.push(root);
  const main = join(root, 'main');
  mkdirSync(join(main, 'src'), { recursive: true });
  writeFileSync(
    join(main, 'package.json'),
    JSON.stringify({
      name: 'fx',
      private: true,
      type: 'module',
      devDependencies: { lefthook: '2.2.2' },
    }),
  );
  writeFileSync(
    join(main, 'lefthook.yml'),
    'pre-commit:\n  jobs:\n    - name: a\n      run: echo a\n',
  );
  writeFileSync(join(main, 'src', 'index.ts'), 'export const x = 1;\n');
  // The repository's own plugin settings, which are what this checks.
  const real = KnipConfig.parse(JSON.parse(readFileSync(join(repoRoot, 'knip.json'), 'utf8')));
  writeFileSync(
    join(main, 'knip.json'),
    JSON.stringify({ entry: ['src/index.ts'], lefthook: real.lefthook }),
  );
  git(main, 'init', '-q', '-b', 'main');
  for (const [key, value] of [
    ['maintenance.auto', 'false'],
    ['gc.auto', '0'],
    ['receive.autogc', 'false'],
    ['user.name', 'test'],
    ['user.email', 'test@example.com'],
    ['commit.gpgsign', 'false'],
  ] as const)
    git(main, 'config', key, value);
  git(main, 'add', 'package.json', 'lefthook.yml', 'src/index.ts', 'knip.json');
  git(
    main,
    'commit',
    '-q',
    '-m',
    'init',
    '--',
    'package.json',
    'lefthook.yml',
    'src/index.ts',
    'knip.json',
  );
  const linked = join(root, 'linked');
  git(main, 'worktree', 'add', '-q', linked, '-b', 'task');
  return linked;
}

describe('knip in a linked worktree', () => {
  it('reads no git hooks from the main checkout, which a sandboxed gate cannot read', () => {
    const linked = linkedWorktree();
    const knip = resolve(repoRoot, 'node_modules', '.bin', 'knip');
    const run = spawnSync(knip, ['--debug'], {
      cwd: linked,
      env: envWithoutGitVariables(),
      encoding: 'utf8',
    });
    // The lefthook plugin looks for hooks at the git directory's `hooks`, which for a worktree is the
    // main checkout's; a read denied there fails knip's whole file walk, so every export looks unused.
    expect(run.stdout).not.toContain('.git/hooks');
  });
});
