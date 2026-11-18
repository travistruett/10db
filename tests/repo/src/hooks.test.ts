import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBareRepo,
  createThrowawayRepo,
  isolatedGitEnvironment,
  fakeGithubToken,
  LEFTHOOK_MISSING,
  SANDBOXED,
  type ThrowawayRepo,
} from './fixtures';
import { readRepoFile, repoRoot } from './workspace';

// mise's lefthook, from PATH: the one the installed hooks name.
const LEFTHOOK = 'lefthook';
const COMMITLINT = resolve(repoRoot, 'node_modules/.bin/commitlint');
// LEFTHOOK=0 in the caller's shell would silently skip every hook and pass these tests. The
// isolated git environment keeps a contributor's global git config out of the throwaway repos.
const ENV = { ...isolatedGitEnvironment(), LEFTHOOK: '1', NO_COLOR: '1' };

function run(command: string, args: string[], cwd: string, input = '') {
  const result = spawnSync(command, args, { cwd, input, encoding: 'utf8', env: ENV });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe.skipIf(LEFTHOOK_MISSING)('lefthook.yml', () => {
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

// Tests are CI's job: a push is not held for longer than the run it starts.
it('runs make precheck before a push, not make check', () => {
  expect(readRepoFile('lefthook.yml')).toMatch(/\bmake precheck\n/);
  expect(readRepoFile('lefthook.yml')).not.toMatch(/\bmake check\n/);
});

// Every checkout shares one .git/hooks, and a hook names the lefthook that installed it. A lefthook
// inside a checkout would let whatever can write that checkout run as the builder on their next
// commit, and each install would rewrite the hooks for every other checkout.
describe.skipIf(LEFTHOOK_MISSING)('installed git hooks', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const remove of cleanup.splice(0)) remove();
  });

  const temporaryDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
    cleanup.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  };

  /** A repository holding `config` as its lefthook.yml, and a linked worktree with no node_modules. */
  function repoWithWorktree(config: string): { repo: ThrowawayRepo; worktree: string } {
    const repo = createThrowawayRepo('10db-installed-hooks');
    cleanup.push(() => {
      repo.remove();
    });
    repo.stage('lefthook.yml', config);
    repo.commit('chore(repo): init');
    const worktree = temporaryDir('10db-installed-hooks-worktree');
    rmSync(worktree, { recursive: true });
    repo.git('worktree', 'add', '-q', '-b', 'feat/y', worktree);
    return { repo, worktree };
  }

  function install(cwd: string): void {
    const result = run(LEFTHOOK, ['install'], cwd);
    expect(result.status, result.output).toBe(0);
  }

  /** The hooks lefthook wrote into the shared git directory, by name. */
  function installedHooks(repo: ThrowawayRepo): Record<string, string> {
    const hooks = join(repo.dir, '.git', 'hooks');
    return Object.fromEntries(
      readdirSync(hooks)
        .filter((name) => !name.endsWith('.sample'))
        .sort()
        .map((name) => [name, readFileSync(join(hooks, name), 'utf8')]),
    );
  }

  it('names a lefthook outside every checkout, byte-identical whichever checkout installed it', () => {
    const { repo, worktree } = repoWithWorktree(readRepoFile('lefthook.yml'));
    install(repo.dir);
    const fromMain = installedHooks(repo);
    expect(Object.keys(fromMain)).toEqual(['commit-msg', 'pre-commit', 'pre-push']);
    for (const name of Object.keys(fromMain)) rmSync(join(repo.dir, '.git', 'hooks', name));

    install(worktree);

    expect(installedHooks(repo)).toEqual(fromMain);
    const checkouts = [repoRoot, repo.dir, worktree].flatMap((dir) => [dir, realpathSync(dir)]);
    for (const [name, hook] of Object.entries(fromMain)) {
      // The absolute path of the lefthook that ran `install`, which the hook falls back to.
      const named = /^\s*elif '?(\/[^' ]+)'? -h >\/dev\/null 2>&1$/m.exec(hook)?.[1];
      expect(named, `${name} names no lefthook:\n${hook}`).toBeDefined();
      for (const path of [named ?? '', realpathSync(named ?? '')]) {
        expect(path, name).not.toContain('/node_modules/');
        const inside = checkouts.filter((checkout) => path.startsWith(`${checkout}${sep}`));
        expect(inside, `${name} names ${path}`).toEqual([]);
      }
    }
  });

  it('runs pre-commit, commit-msg and pre-push from a worktree with no node_modules and no lefthook on PATH', () => {
    const records = temporaryDir('10db-installed-hooks-record');
    const record = join(records, 'hooks');
    const config = ['pre-commit', 'commit-msg', 'pre-push']
      .map(
        (hook) =>
          `${hook}:\n  jobs:\n    - name: record\n      run: echo ${hook} >> "$HOOK_RECORD"\n`,
      )
      .join('\n');
    const { repo, worktree } = repoWithWorktree(config);
    const origin = createBareRepo('10db-installed-hooks-origin');
    cleanup.push(() => {
      origin.remove();
    });
    repo.git('remote', 'add', 'origin', origin.dir);
    install(repo.dir);

    // A terminal with git and the system's own directories on PATH: no lefthook, no mise, no
    // node_modules, and no LEFTHOOK_BIN.
    const bin = join(records, 'bin');
    mkdirSync(bin);
    const gitPath = execFileSync('sh', ['-c', 'command -v git'], {
      env: isolatedGitEnvironment(),
      encoding: 'utf8',
    }).trim();
    symlinkSync(gitPath, join(bin, 'git'));
    const env = {
      ...Object.fromEntries(
        Object.entries(isolatedGitEnvironment()).filter(([name]) => name !== 'LEFTHOOK_BIN'),
      ),
      PATH: [bin, '/usr/bin', '/bin'].join(delimiter),
      LEFTHOOK: '1',
      NO_COLOR: '1',
      HOOK_RECORD: record,
    };
    expect(spawnSync('sh', ['-c', 'command -v lefthook'], { env }).status).not.toBe(0);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: worktree, env, encoding: 'utf8' });
      expect(result.status, `git ${args.join(' ')}: ${result.stdout}${result.stderr}`).toBe(0);
    };
    writeFileSync(join(worktree, 'change.txt'), 'a change\n');

    git('add', 'change.txt');
    git('commit', '-q', '-m', 'feat(repo): a change');
    git('push', '-q', 'origin', 'feat/y');

    const ran = existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
    expect(ran).toEqual(['pre-commit', 'commit-msg', 'pre-push']);
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
    ['no scope', 'feat: add the health endpoint', true],
    ['no type or scope', 'add the health endpoint', false],
    ['a scope off the list', 'feat(web): add the health endpoint', false],
    ['a capitalized subject', 'feat(daemon): Add the health endpoint', false],
  ])('%s', (_name, message, valid) => {
    expect(run(COMMITLINT, [], repoRoot, message).status === 0).toBe(valid);
  });
});

describe.skipIf(LEFTHOOK_MISSING)('pre-commit in a throwaway repo', () => {
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
