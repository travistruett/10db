import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDto, TaskDto, WorkstreamDto } from '@10db/contracts';
import { insertTask, insertWorkstream, seedProject, type Store } from '@10db/db';
import type { Keychain } from '../src/environment';

export interface TempDir {
  path: string;
  cleanup(): void;
}

export function tempDir(prefix: string): TempDir {
  const path = mkdtempSync(join(tmpdir(), `10db-${prefix}-`));
  return {
    path,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/**
 * An environment for a git child process that only the repository it runs in can steer: no
 * inherited `GIT_*` variable (git exports `GIT_DIR`, `GIT_INDEX_FILE` and more to a hook, which would
 * redirect the child to the outer repository) and no system or global config.
 */
export function isolatedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

/**
 * Local config every test repository gets before its first commit. Without it git starts a detached
 * `git maintenance run --auto` after a commit, which goes on writing under `.git` (it holds
 * `objects/maintenance.lock`) after the command returns and races any test that reads those files.
 * In a bare origin, receive-pack starts one after a push, and an older git's receive-pack starts
 * `git gc --auto` instead; `receive.autogc` stops receive-pack starting either. Being local, it
 * reaches every git process that touches the repository, whatever its environment.
 */
export const TEST_REPO_CONFIG = {
  'maintenance.auto': 'false',
  'gc.auto': '0',
  'receive.autogc': 'false',
} as const;

/** A real git repository with one commit on main, for tests that touch git or files. */
export function createTempRepo(): TempDir {
  const dir = tempDir('repo');
  const env = isolatedGitEnv();
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir.path, ...args], { env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  for (const [key, value] of Object.entries(TEST_REPO_CONFIG)) git('config', key, value);
  git('config', 'user.name', '10db test');
  git('config', 'user.email', 'test@10db.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir.path, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'Initial commit');
  return dir;
}

/**
 * What network calls get in tests: enough PATH to find git and gh scripts, and the same config
 * isolation as `isolatedGitEnv`, nothing else.
 */
export const NETWORK_ENV: Readonly<Record<string, string>> = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

/** A temp repo whose `origin` is a local bare repo holding `main`, so fetch and push are real. */
export function createTempRepoWithOrigin(): { repo: TempDir; origin: TempDir; cleanup(): void } {
  const origin = tempDir('origin');
  const env = isolatedGitEnv();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin.path], { env, stdio: 'pipe' });
  for (const [key, value] of Object.entries(TEST_REPO_CONFIG))
    execFileSync('git', ['--git-dir', origin.path, 'config', key, value], { env, stdio: 'pipe' });
  const repo = createTempRepo();
  execFileSync('git', ['-C', repo.path, 'remote', 'add', 'origin', origin.path], {
    env,
    stdio: 'pipe',
  });
  execFileSync('git', ['-C', repo.path, 'push', '-q', 'origin', 'main'], { env, stdio: 'pipe' });
  return {
    repo,
    origin,
    cleanup: () => {
      repo.cleanup();
      origin.cleanup();
    },
  };
}

/** A clone of `origin` with a teammate's identity, for a test that moves origin from elsewhere. */
export function createTempClone(origin: string): TempDir {
  const dir = tempDir('clone');
  const env = isolatedGitEnv();
  // `clone -c` writes the config into the new repository before anything is fetched or committed.
  const config = Object.entries(TEST_REPO_CONFIG).flatMap(([key, value]) => [
    '-c',
    `${key}=${value}`,
  ]);
  execFileSync('git', ['clone', '-q', ...config, origin, dir.path], { env, stdio: 'pipe' });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir.path, ...args], { env, stdio: 'pipe' });
  git('config', 'user.name', 'teammate');
  git('config', 'user.email', 'teammate@10db.invalid');
  git('config', 'commit.gpgsign', 'false');
  return dir;
}

export function seedWorkstream(
  store: Store,
  opts: {
    project?: ProjectDto;
    title?: string;
    areas?: string[];
    repoPath?: string;
    gateCommand?: string;
  } = {},
): { project: ProjectDto; task: TaskDto; workstream: WorkstreamDto } {
  const project =
    opts.project ??
    seedProject(store, {
      ...(opts.repoPath ? { repoPath: opts.repoPath } : {}),
      ...(opts.gateCommand ? { gateCommand: opts.gateCommand } : {}),
    });
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, {
      title: opts.title ?? 'Alpha',
      acceptanceCriteria: ['it works'],
      areas: opts.areas ?? ['api'],
    }),
  ).value;
  const workstream = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
  return { project, task, workstream };
}

/** Polls `check` until it returns a value (not undefined/false) or the deadline passes. */
export async function waitFor<T>(
  check: () => T | undefined | false,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Arguments for the write_handoff MCP tool in fake scripts. */
export function handoffArgs(opId: string, nextAction: string): Record<string, unknown> {
  return {
    opId,
    objective: { task: 'scripted', acceptanceCriteria: ['it works'], nonGoals: [] },
    progress: { done: ['first half'], notDone: ['second half'], nextAction },
    codeState: { uncommittedSummary: '' },
    reasoning: { decisions: [], tradeOffs: [], rejected: [] },
    validation: { checks: [], environmentProblems: [] },
    continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
  };
}

/** Polls an async `check` until it returns a value (not undefined/false) or the deadline passes. */
export async function waitForAsync<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitForAsync timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A Keychain double at the `Keychain` interface: items live in memory, `items` seeds it. */
export function createMemoryKeychain(items: Record<string, string> = {}): Keychain {
  const map = new Map(Object.entries(items));
  return {
    read: (account) => map.get(account) ?? null,
    write: (account, secret) => {
      map.set(account, secret);
    },
  };
}
