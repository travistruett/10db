import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDto, TaskDto, WorkstreamDto } from '@10db/contracts';
import {
  getSession,
  insertSession,
  insertTask,
  insertWorkstream,
  seedProject,
  updateSessionUsage,
  type SessionRow,
  type Store,
} from '@10db/db';
import { inject } from 'vitest';
import type { Keychain } from '../src/environment';
import type { SandboxRuntime } from '../src/sandbox';

export interface TempDir {
  path: string;
  cleanup(): void;
}

/**
 * True inside a sandbox: every sandboxed command, a lane's or a gate's, gets `TENDB_SANDBOX=1`. A
 * test that needs what no sandbox gives (a setuid `ps`, the shared `/tmp`, the builder's own home,
 * Seatbelt itself) skips there and says which; CI and an unsandboxed `make gate` still run it.
 */
export const SANDBOXED = process.env['TENDB_SANDBOX'] === '1';

/** srt's stand-in for daemon tests that run no Seatbelt; see `fake-srt.ts`. */
export const FAKE_SRT: SandboxRuntime = {
  node: process.execPath,
  cli: join(import.meta.dirname, 'fake-srt.ts'),
};

export function tempDir(prefix: string): TempDir {
  const path = mkdtempSync(join(tmpdir(), `10db-${prefix}-`));
  return {
    path,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** How much of a check's output 10db keeps: `TAIL_BYTES` in `src/verify/gate-runner.ts`. */
const CHECK_TAIL_CHARS = 4096;

/** What `failedRepoCheck` hands back: where the check ran, and what 10db read from it. */
interface FailedRepoCheck {
  readonly checkout: string;
  readonly exitCode: number;
  readonly tail: string;
}

/**
 * Runs this repository's own step check, scripts/check-changed.mjs, on a small workspace with a stub
 * `pnpm` whose vitest fails printing `testLog` and whose every other command passes. So a test reads
 * what `make check-changed` (or, with `--precheck`, `make precheck`) really leaves: the end of its
 * output and its logs in the checkout.
 */
export function failedRepoCheck(testLog: string, flags: readonly string[] = []): FailedRepoCheck {
  const checkout = tempDir('repo-check').path;
  for (const dir of ['scripts', 'bin', 'apps/x/src', 'docs'])
    mkdirSync(join(checkout, dir), { recursive: true });
  cpSync(
    join(import.meta.dirname, '../../../scripts/check-changed.mjs'),
    join(checkout, 'scripts/check-changed.mjs'),
  );
  writeFileSync(join(checkout, 'apps/x/package.json'), '{"name":"x"}');
  writeFileSync(join(checkout, 'apps/x/src/a.ts'), 'export {};\n');
  writeFileSync(join(checkout, 'docs/a.md'), 'a\n');
  writeFileSync(join(checkout, 'test-output.txt'), testLog);
  const pnpm = join(checkout, 'bin/pnpm');
  writeFileSync(
    pnpm,
    `#!/bin/sh\ncase "$1 $2 $3" in\n  "exec vitest run") /bin/cat '${join(checkout, 'test-output.txt')}'; exit 1 ;;\nesac\n`,
  );
  chmodSync(pnpm, 0o755);
  const result = spawnSync(
    process.execPath,
    ['scripts/check-changed.mjs', ...flags, '--', 'apps/x/src/a.ts', 'docs/a.md'],
    { cwd: checkout, encoding: 'utf8', env: { PATH: join(checkout, 'bin') } },
  );
  return {
    checkout,
    exitCode: result.status ?? 1,
    tail: `${result.stdout}${result.stderr}`.slice(-CHECK_TAIL_CHARS),
  };
}

/**
 * An environment for a git child process that only the repository it runs in can steer: no
 * inherited `GIT_*` variable (git exports `GIT_DIR`, `GIT_INDEX_FILE` and more to a hook, which would
 * redirect the child to the outer repository) and no system or global config. Git's default excludes file
 * (`$XDG_CONFIG_HOME/git/ignore`, by default `~/.config/git/ignore`) is read even with the global config off,
 * so `core.excludesFile` is pinned to `/dev/null` too: what a contributor ignores can't change a result.
 * (The daemon's own git drops `GIT_CONFIG_COUNT`; there `tests/git-isolation.setup.ts` points
 * `XDG_CONFIG_HOME` at a private directory.)
 */
export function isolatedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.excludesFile',
    GIT_CONFIG_VALUE_0: '/dev/null',
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

/**
 * Builds the repository `createTempRepo` copies: one commit on main, with `TEST_REPO_CONFIG` and a
 * test identity. `repo-template.global.ts` builds it once per test run and removes it after.
 */
export function buildRepoTemplate(): TempDir {
  const dir = tempDir('repo-template');
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

/** A real git repository with one commit on main, for tests that touch git or files. */
export function createTempRepo(): TempDir {
  const dir = tempDir('repo');
  // A copy is a few file writes where a build is nine git calls, and the daemon's tests make over a
  // thousand repositories.
  cpSync(inject('repoTemplate'), dir.path, { recursive: true });
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

/** The URL the template pair's `origin` has until a copy points it at its own bare repository. */
const TEMPLATE_ORIGIN = 'ORIGIN-OF-THE-TEMPLATE';

/**
 * A temp repo whose `origin` is a local bare repo holding `main`, so fetch and push are real. Both
 * are copies of the pair `buildRemoteTemplate` made: a copy is file writes, where building the pair
 * takes a dozen git calls, and every delivery test makes one while other lanes load the machine.
 */
export function createTempRepoWithOrigin(): { repo: TempDir; origin: TempDir; cleanup(): void } {
  const { repo: repoTemplate, origin: originTemplate } = inject('remoteTemplate');
  const origin = tempDir('origin');
  cpSync(originTemplate, origin.path, { recursive: true });
  const repo = tempDir('repo');
  cpSync(repoTemplate, repo.path, { recursive: true });
  const config = join(repo.path, '.git', 'config');
  const text = readFileSync(config, 'utf8');
  if (!text.includes(TEMPLATE_ORIGIN)) throw new Error('the template repository lost its origin');
  writeFileSync(config, text.replace(TEMPLATE_ORIGIN, origin.path));
  return {
    repo,
    origin,
    cleanup: () => {
      repo.cleanup();
      origin.cleanup();
    },
  };
}

/**
 * Builds the pair `createTempRepoWithOrigin` copies: the template repository with its `origin` a
 * bare repository holding `main`, and `refs/remotes/origin/main` as a push leaves it. The repository's
 * URL is a placeholder a copy replaces. `repo-template.global.ts` builds it once per test run and
 * removes it after.
 */
export function buildRemoteTemplate(): { repo: TempDir; origin: TempDir; cleanup(): void } {
  const origin = tempDir('origin-template');
  const env = isolatedGitEnv();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin.path], { env, stdio: 'pipe' });
  // A test that commits in the origin itself (as GitHub's branch update does) needs an identity:
  // CI's git can't guess one from the host name the way a Mac's does.
  const originConfig = {
    ...TEST_REPO_CONFIG,
    'user.name': 'github',
    'user.email': 'github@10db.invalid',
    'commit.gpgsign': 'false',
  };
  for (const [key, value] of Object.entries(originConfig))
    execFileSync('git', ['--git-dir', origin.path, 'config', key, value], { env, stdio: 'pipe' });
  const repo = buildRepoTemplate();
  execFileSync('git', ['-C', repo.path, 'remote', 'add', 'origin', origin.path], {
    env,
    stdio: 'pipe',
  });
  execFileSync('git', ['-C', repo.path, 'push', '-q', 'origin', 'main'], { env, stdio: 'pipe' });
  execFileSync('git', ['-C', repo.path, 'remote', 'set-url', 'origin', TEMPLATE_ORIGIN], {
    env,
    stdio: 'pipe',
  });
  return {
    repo,
    origin,
    cleanup: () => {
      repo.cleanup();
      origin.cleanup();
    },
  };
}

/** The origin a delivery test pins: the repository `FakeGh` answers for. */
export const GITHUB_ORIGIN = 'https://github.com/acme/widgets.git';

/**
 * Points `repo`'s origin at `GITHUB_ORIGIN`, as the daemon pins it and gh is told it, and returns a
 * global config file that sends that URL to the local bare `origin`. Network calls and a test's own
 * pushes read it through `GIT_CONFIG_GLOBAL`; the daemon's local git does not, so it pins github.com.
 */
export function githubOrigin(repo: string, origin: string): { global: string; cleanup(): void } {
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', GITHUB_ORIGIN], {
    env: isolatedGitEnv(),
    stdio: 'pipe',
  });
  const dir = tempDir('network-config');
  const global = join(dir.path, 'gitconfig');
  writeFileSync(global, `[url "${origin}"]\n\tinsteadOf = ${GITHUB_ORIGIN}\n`);
  return {
    global,
    cleanup: () => {
      dir.cleanup();
    },
  };
}

/** A clone of `origin` with a teammate's identity, for a test that moves origin from elsewhere. */
export function createTempClone(origin: string): TempDir {
  const dir = tempDir('clone');
  const env = isolatedGitEnv();
  // `clone -c` writes the config into the new repository before anything is fetched or committed,
  // the identity too: a call for each key costs a spawn, and a teammate's push makes a clone.
  const config = Object.entries({
    ...TEST_REPO_CONFIG,
    'user.name': 'teammate',
    'user.email': 'teammate@10db.invalid',
    'commit.gpgsign': 'false',
  }).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
  execFileSync('git', ['clone', '-q', ...config, origin, dir.path], { env, stdio: 'pipe' });
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
    readAsync: (account) => Promise.resolve(map.get(account) ?? null),
    write: (account, secret) => {
      map.set(account, secret);
    },
    remove: (account) => {
      map.delete(account);
    },
  };
}

/** One session on `project`'s account that has spent `costUsd`, started at the store's now. */
export function seedSpend(store: Store, project: ProjectDto, costUsd: number): SessionRow {
  return store.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: `spend ${String(Math.random())}`,
      acceptanceCriteria: ['x'],
      areas: [project.areas[0]?.name ?? 'api'],
    });
    const ws = insertWorkstream(ctx, task.id);
    const session = insertSession(ctx, {
      workstreamId: ws.id,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: `spend-${String(Math.random())}`,
    });
    updateSessionUsage(ctx, session.id, { costUsd });
    return getSession(ctx.tx, session.id);
  }).value;
}
