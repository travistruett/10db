import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createThrowawayRepo,
  isolatedGitEnvironment,
  fakeGithubToken,
  SANDBOXED,
  type ThrowawayRepo,
} from './fixtures';
import { repoRoot } from './workspace';

const LEFTHOOK = resolve(repoRoot, 'node_modules/.bin/lefthook');
const COMMITLINT = resolve(repoRoot, 'node_modules/.bin/commitlint');
// LEFTHOOK=0 in the caller's shell would silently skip every hook and pass these tests. The
// isolated git environment keeps a contributor's global git config out of the throwaway repos.
const ENV = { ...isolatedGitEnvironment(), LEFTHOOK: '1', NO_COLOR: '1' };

function run(command: string, args: string[], cwd: string, input = '') {
  const result = spawnSync(command, args, { cwd, input, encoding: 'utf8', env: ENV });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('lefthook.yml', () => {
  it('is a valid lefthook config', () => {
    expect(run(LEFTHOOK, ['validate'], repoRoot).status).toBe(0);
  });

  it('wires every local check to its hook', () => {
    const dumped = JSON.parse(
      run(LEFTHOOK, ['dump', '--format', 'json'], repoRoot).output,
    ) as Record<string, { jobs: { name: string }[] }>;
    const names = (hook: string) => (dumped[hook]?.jobs ?? []).map((job) => job.name);
    expect(names('pre-commit')).toEqual(['gitleaks', 'hygiene', 'prettier', 'eslint', 'cargo-fmt']);
    expect(names('commit-msg')).toEqual(['commitlint']);
    expect(names('pre-push')).toEqual(['no-push-to-main', 'check']);
  });
});

describe('commitlint', () => {
  it.each<[string, string, boolean]>([
    ['type, scope and subject', 'feat(daemon): add the health endpoint', true],
    [
      'a trailer in the body',
      'fix(db): close the client\n\nCo-Authored-By: A <a@example.com>',
      true,
    ],
    ['the release-please title', 'chore(repo): release 0.1.0', true],
    ['a Renovate title', 'chore(deps): update dependency vite to v8.3.5', true],
    ['no type', 'Add the health endpoint', false],
    ['no scope', 'feat: add the health endpoint', false],
    ['a scope off the list', 'feat(web): add the health endpoint', false],
    ['a capitalized subject', 'feat(daemon): Add the health endpoint', false],
  ])('%s', (_name, message, valid) => {
    expect(run(COMMITLINT, [], repoRoot, message).status === 0).toBe(valid);
  });
});

describe('pre-commit in a throwaway repo', () => {
  let repo: ThrowawayRepo;
  const preCommit = (job: string) =>
    run(LEFTHOOK, ['run', 'pre-commit', '--job', job, '--no-auto-install', '--no-tty'], repo.dir);

  beforeEach(() => {
    repo = createThrowawayRepo('10db-hooks');
    cpSync(resolve(repoRoot, 'lefthook.yml'), join(repo.dir, 'lefthook.yml'));
    cpSync(resolve(repoRoot, 'scripts/hooks'), join(repo.dir, 'scripts/hooks'), {
      recursive: true,
    });
    repo.git('add', 'lefthook.yml', 'scripts/hooks');
    repo.commit('chore(repo): init');
  });

  afterEach(() => {
    repo.remove();
  });

  it('passes a clean staged file', () => {
    repo.stage('src/ok.ts', 'export const ok = true;\n');
    expect(preCommit('hygiene').status).toBe(0);
    expect(preCommit('gitleaks').status).toBe(0);
  });

  // gitleaks can't scan in a sandbox where git is Apple's shim; see SANDBOXED.
  it.skipIf(SANDBOXED)(
    'refuses a planted secret, and the report shows a gitleaks finding without the token',
    () => {
      const { token, body } = fakeGithubToken();
      repo.stage('src/config.ts', `export const token = '${token}';\n`);
      const { status, output } = preCommit('gitleaks');
      expect(status).not.toBe(0);
      // A missing gitleaks binary also exits non-zero, so require the scanner's own finding count.
      expect(output).toContain('leaks found: 1');
      expect(output).not.toContain(body);
    },
  );

  it.each<[string, string, string | Buffer, string]>([
    ['a file under scratch/', 'scratch/notes.md', 'private\n', 'never committed'],
    ['.claude/settings.local.json', '.claude/settings.local.json', '{}\n', 'never committed'],
    [
      'a merge conflict marker',
      'src/a.ts',
      'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n',
      'conflict',
    ],
    ['a file over 1 MB', 'assets/big.bin', Buffer.alloc(1024 * 1024 + 1), '1 MB'],
  ])('refuses %s', (_name, path, content, message) => {
    repo.stage(path, content);
    const { status, output } = preCommit('hygiene');
    expect(status).not.toBe(0);
    expect(output).toContain(message);
  });

  it('refuses paths that collide on a case-insensitive file system', () => {
    repo.stage('README.md', 'a\n');
    // macOS can't hold both names on disk, so add the second straight to the index.
    const blob = repo.gitOutput('hash-object', '-w', 'README.md');
    repo.git('update-index', '--add', '--cacheinfo', `100644,${blob},readme.md`);
    const { status, output } = preCommit('hygiene');
    expect(status).not.toBe(0);
    expect(output).toContain('case-insensitive');
  });
});

describe('pre-push', () => {
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  const ZERO = '0'.repeat(40);
  const push = (line: string) => run('node', ['scripts/hooks/pre-push.mjs'], repoRoot, `${line}\n`);

  it.each<[string, string, boolean]>([
    ['updating main', `refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}`, false],
    ['deleting main', `(delete) ${ZERO} refs/heads/main ${SHA_B}`, false],
    ['creating main in a new repository', `refs/heads/main ${SHA_A} refs/heads/main ${ZERO}`, true],
    ['pushing a branch', `refs/heads/feat/x ${SHA_A} refs/heads/feat/x ${SHA_B}`, true],
  ])('%s', (_name, line, allowed) => {
    expect(push(line).status === 0).toBe(allowed);
  });
});
