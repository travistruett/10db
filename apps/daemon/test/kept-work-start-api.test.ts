import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Delivery, ProjectDto, TaskDto, TaskId, WorkstreamState } from '@10db/contracts';
import { getTaskKeptWork, listTaskThread, listWorkstreams, setTaskKeptWork } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, isolatedGitEnv, tempDir, waitFor } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

// Workbench spec §5.4, call 33: a task taken out of a pass keeps its work saved. Starting it from the
// Board puts that work back in Your folder first, and only then queues its run; the work is never
// lost to a start.

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('kept work start');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    caps: { global: 0 },
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
  it('puts the work back in Your folder of a local project, then lets the run launch', async () => {
    const project = await api().post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      delivery: Delivery.Local,
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Settings: UI work',
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
    // The put-back's last write records that nothing is saved any more.
    await waitFor(() => getTaskKeptWork(daemon.state.db, taskId) === null);
    expect(readFileSync(join(repo.path, 'src/settings.ts'), 'utf8')).toBe('saved\n');
    // No lane can start here (the daemon-wide cap is 0): the put-back ran ahead of any launch.
    expect(
      listWorkstreams(daemon.state.db, { projectId: project.id }).map((ws) => [
        ws.taskId,
        ws.state,
      ]),
    ).toEqual([[taskId, WorkstreamState.Queued]]);
    expect(getTaskKeptWork(daemon.state.db, taskId)).toBeNull();
    expect(listTaskThread(daemon.state.db, taskId).map((m) => m.body)).toContain(
      'Put back its saved Workbench work: 1 file.',
    );
  });
});
