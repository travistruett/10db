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

/** A real git repository with one commit on main, for tests that touch git or files. */
export function createTempRepo(): TempDir {
  const dir = tempDir('repo');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir.path, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', '10db test');
  git('config', 'user.email', 'test@10db.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir.path, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'Initial commit');
  return dir;
}

/** What network calls get in tests: enough PATH to find git and gh scripts, nothing else. */
export const NETWORK_ENV: Readonly<Record<string, string>> = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
};

/** A temp repo whose `origin` is a local bare repo holding `main`, so fetch and push are real. */
export function createTempRepoWithOrigin(): { repo: TempDir; origin: TempDir; cleanup(): void } {
  const origin = tempDir('origin');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin.path], { stdio: 'pipe' });
  const repo = createTempRepo();
  execFileSync('git', ['-C', repo.path, 'remote', 'add', 'origin', origin.path], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo.path, 'push', '-q', 'origin', 'main'], { stdio: 'pipe' });
  return {
    repo,
    origin,
    cleanup: () => {
      repo.cleanup();
      origin.cleanup();
    },
  };
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
