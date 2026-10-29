import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintId, ProjectDto, TaskDto, WorkstreamChangesDto, WorkstreamDto } from '@10db/contracts';
import { patchWorkstream } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, isolatedGitEnv, tempDir } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('workstream changes');
  repo = createTempRepo();
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    // A tick long enough that a started task stays where the test left it.
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);
const rawGit = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], {
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();

async function get(path: string) {
  const res = await fetch(`${daemon.url}${path}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

async function startedWorkstream() {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: null,
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
  const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'change things',
    acceptanceCriteria: ['x'],
    areas: ['src'],
    dependsOn: [],
  });
  return api().post(`/tasks/${task.id}/start`, WorkstreamDto);
}

describe('GET /workstreams/:id/changes', () => {
  it("answers the workstream's changes from its checkout", async () => {
    const ws = await startedWorkstream();
    const baseHead = rawGit('rev-parse', 'HEAD');
    daemon.state.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, { baseHead });
    });
    writeFileSync(join(repo.path, 'feature.txt'), 'hello\nworld\n');
    rawGit('add', 'feature.txt');
    rawGit('commit', '-q', '-m', 'add feature');

    const changes = await api().get(`/workstreams/${ws.id}/changes`, WorkstreamChangesDto);

    expect(changes.baseHead).toBe(baseHead);
    expect(changes.head).toBe(rawGit('rev-parse', 'HEAD'));
    expect(changes.commits).toEqual([changes.head]);
    expect(changes.truncated).toBe(false);
    expect(changes.diff).toContain('+world');
    expect(changes.files).toEqual([{ path: 'feature.txt', added: 2, removed: 0 }]);
  });

  it('answers 404 for a workstream that does not exist', async () => {
    const res = await get(`/workstreams/${mintId('Workstream')}/changes`);
    expect(res.status).toBe(404);
  });

  it('answers 409 for a workstream that has not started in a checkout', async () => {
    const ws = await startedWorkstream();
    const res = await get(`/workstreams/${ws.id}/changes`);
    expect(res.status).toBe(409);
  });

  it('answers 404 when its checkout is gone', async () => {
    const ws = await startedWorkstream();
    daemon.state.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, { baseHead: rawGit('rev-parse', 'HEAD') });
    });
    rmSync(repo.path, { recursive: true, force: true });

    const res = await get(`/workstreams/${ws.id}/changes`);
    expect(res.status).toBe(404);
  });
});
