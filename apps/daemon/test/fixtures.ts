import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDto, TaskDto, WorkstreamDto } from '@10db/contracts';
import { insertTask, insertWorkstream, seedProject, type Store } from '@10db/db';

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

/** A real git repository with one commit on main, for tests that touch git or files. */
export function createTempRepo(): TempDir {
  const dir = tempDir('repo');
  const env = isolatedGitEnv();
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir.path, ...args], { env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', '10db test');
  git('config', 'user.email', 'test@10db.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir.path, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'Initial commit');
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
