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
