import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A GitHub-token-shaped string that gitleaks flags, built at run time so no source file ever
 * contains a token a scanner would match. Returns the prefixed token and its random body.
 */
/**
 * True inside a sandbox (`TENDB_SANDBOX=1`, which every lane and gate command gets). There Apple's
 * `/usr/bin/git` shim prints an error on every call, as it can't write its cache, and gitleaks takes
 * any output from git on stderr as a failed scan and reports no leaks; its tests skip there and CI
 * runs them.
 */
export const SANDBOXED = process.env['TENDB_SANDBOX'] === '1';

export function fakeGithubToken(): { token: string; body: string } {
  const body = [...randomBytes(36)]
    .map((byte) => TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length])
    .join('');
  return { token: `ghp_${body}`, body };
}

/**
 * The process environment without the `GIT_*` variables that point git at a repository
 * (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE` and the like). Git sets them while it runs a
 * hook, and a child that inherits them would operate on the outer repository instead of its own.
 */
export function envWithoutGitVariables(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
}

/**
 * The environment for a throwaway repository: no `GIT_*` repository variables, and no global or
 * system git config. A contributor's `commit.gpgsign`, `core.hooksPath` or identity would
 * otherwise reach every commit a test makes.
 */
export function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  return { ...envWithoutGitVariables(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

/** The SHA-256 of every file under `dir`, keyed by relative path: two equal snapshots mean no byte changed. */
export function snapshotFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return files;
}

/**
 * Local config every test repository gets before its first commit or push. Without it git starts a
 * detached `git maintenance run --auto` after a commit, and receive-pack starts one in a bare
 * repository after a push. It goes on writing under the repository (it holds
 * `objects/maintenance.lock`) after the command returns, which races a test that snapshots the
 * files or removes the directory. An older git's receive-pack starts `git gc --auto` instead;
 * `receive.autogc` stops receive-pack starting either. Being local, it reaches every git process
 * that touches the repository.
 */
const TEST_REPO_CONFIG = {
  'maintenance.auto': 'false',
  'gc.auto': '0',
  'receive.autogc': 'false',
} as const;

/** A real git repository in a temporary directory, for tests that run hooks and scripts. */
export interface ThrowawayRepo {
  readonly dir: string;
  /** The environment to give a child process that runs in the repository. */
  readonly env: NodeJS.ProcessEnv;
  /** Runs git in the repository and discards its output. */
  git(...args: string[]): void;
  /** Runs git in the repository and returns its trimmed output. */
  gitOutput(...args: string[]): string;
  /** Writes a file (creating its directories) and force-adds it to the index. */
  stage(path: string, content: string | Buffer): void;
  /** Commits whatever is staged, with a fixed identity and no hooks installed. */
  commit(message: string): void;
  remove(): void;
}

/**
 * Creates an empty repository on branch `feat/x`, in a new temporary directory or at `at`, which
 * must not exist yet. Call `remove` when the test is done.
 */
export function createThrowawayRepo(prefix: string, at?: string): ThrowawayRepo {
  const dir = at ?? mkdtempSync(join(tmpdir(), `${prefix}-`));
  if (at !== undefined) mkdirSync(at, { recursive: true });
  const env = isolatedGitEnvironment();
  const git = (...args: string[]) => {
    execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' });
  };
  git('init', '-q', '-b', 'feat/x');
  for (const [key, value] of Object.entries(TEST_REPO_CONFIG)) git('config', key, value);
  // A local identity, because the global config is ignored and a bare `git commit` needs one.
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.com');
  return {
    dir,
    env,
    git,
    gitOutput: (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim(),
    stage: (path, content) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
      git('add', '-f', path);
    },
    commit: (message) => {
      git('commit', '-q', '-m', message);
    },
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A directory that stands in for the checkout when a test runs `scripts/gate.sh`. */
export interface GateSandbox {
  readonly dir: string;
  remove(): void;
}

/**
 * A temporary directory laid out like the checkout's top level. `scripts/gate.sh` runs in the
 * directory above its own path, so it writes `.gate/` here. The script and the Makefile are links
 * to the checkout's own, so the test runs the real ones. The `package.json` stubs `format:check`,
 * so the format step does not walk the checkout.
 */
export function createGateSandbox(checkout: string): GateSandbox {
  const dir = mkdtempSync(join(tmpdir(), '10db-gate-'));
  mkdirSync(join(dir, 'scripts'));
  symlinkSync(resolve(checkout, 'scripts/gate.sh'), join(dir, 'scripts/gate.sh'));
  symlinkSync(resolve(checkout, 'Makefile'), join(dir, 'Makefile'));
  writeFileSync(
    join(dir, 'package.json'),
    '{"name":"gate-sandbox","private":true,"scripts":{"format:check":"true"}}\n',
  );
  return {
    dir,
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A bare repository in a temporary directory, standing in for the remote a test pushes to. */
export interface BareRepo {
  readonly dir: string;
  /** Runs git against the repository and returns its trimmed output. */
  gitOutput(...args: string[]): string;
  remove(): void;
}

/** Creates an empty bare repository. Call `remove` when the test is done. */
export function createBareRepo(prefix: string): BareRepo {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const env = isolatedGitEnvironment();
  const git = (...args: string[]) =>
    execFileSync('git', ['--git-dir', dir, ...args], { env, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', dir], { env, stdio: 'ignore' });
  for (const [key, value] of Object.entries(TEST_REPO_CONFIG)) git('config', key, value);
  return {
    dir,
    gitOutput: git,
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
