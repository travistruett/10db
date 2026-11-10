import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Delivery, ProjectDto, TaskDto, TaskId } from '@10db/contracts';
import { getTaskKeptWork, listTaskThread, listWorkstreams, setTaskKeptWork } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, isolatedGitEnv, tempDir, waitFor } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

// Workbench spec §5.4, call 33: a task taken out of a pass keeps its work saved. Starting it from the
// Board puts that work back in Your folder before its run's lane starts, through the real
// scheduler with room to launch; the work is never lost to a start.

const TITLE = 'Settings: UI work';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
/** What `src/settings.ts` in each lane's checkout held as its session started. */
let atLaunch: string[];
beforeEach(async () => {
  data = tempDir('kept work start');
  repo = createTempRepo();
  atLaunch = [];
  const adapter = new FakeAdapter({ [TITLE]: [[{ do: 'hang' }]] });
  const start = adapter.start.bind(adapter);
  adapter.start = (spec) => {
    atLaunch.push(readFileSync(join(spec.cwd, 'src/settings.ts'), 'utf8'));
    return start(spec);
  };
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter,
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    // Ticks come from the start and the put-back alone, as the scheduler is asked.
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

function commitFile(path: string, content: string): string {
  const file = join(repo.path, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  git('add', path);
  git('commit', '-q', '-m', `Add ${path}`);
  return git('rev-parse', 'HEAD');
}

describe('POST /tasks/:id/start of a task with saved Workbench work', () => {
  it('puts the work back in Your folder of a local project before its run launches', async () => {
    const project = await api().post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      delivery: Delivery.Local,
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
      title: TITLE,
      acceptanceCriteria: ['x'],
      areas: ['src'],
    });
    const taskId = TaskId.parse(task.id);
    // The saved work, as a take-out keeps it: a commit at the task's kept ref, on the folder's HEAD.
    const base = commitFile('src/settings.ts', 'before\n');
    git('switch', '-q', '-c', 'saved');
    const kept = commitFile('src/settings.ts', 'saved\n');
    git('switch', '-q', '-');
    git('branch', '-q', '-D', 'saved');
    git('update-ref', `refs/10db/kept/${taskId}`, kept);
    daemon.state.write((ctx) => {
      setTaskKeptWork(ctx, taskId, { keptSha: kept, keptBaseSha: base });
    });

    const res = await fetch(`${daemon.url}/tasks/${task.id}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(201);
    // The lane starts once, and only after the put-back wrote the saved work into its checkout.
    await waitFor(() => atLaunch.length > 0);
    expect(atLaunch).toEqual(['saved\n']);
    expect(
      listWorkstreams(daemon.state.db, { projectId: project.id }).map((ws) => ws.taskId),
    ).toEqual([taskId]);
    expect(getTaskKeptWork(daemon.state.db, taskId)).toBeNull();
    expect(listTaskThread(daemon.state.db, taskId).map((m) => m.body)).toContain(
      'Put back its saved Workbench work: 1 file.',
    );
  });
});
