import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A GitHub-token-shaped string that gitleaks flags, built at run time so no source file ever
 * contains a token a scanner would match. Returns the prefixed token and its random body.
 */
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

/** Creates an empty repository on branch `feat/x`. Call `remove` when the test is done. */
export function createThrowawayRepo(prefix: string): ThrowawayRepo {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const env = isolatedGitEnvironment();
  const git = (...args: string[]) => {
    execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' });
  };
  git('init', '-q', '-b', 'feat/x');
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
