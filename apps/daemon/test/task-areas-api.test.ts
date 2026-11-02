import { ProjectDto, TaskDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('task areas');
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

async function patch(path: string, body: unknown) {
  const res = await fetch(`${daemon.url}${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

async function seed() {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [
      { name: 'src', globs: ['src/**'] },
      { name: 'docs', globs: ['docs/**'] },
    ],
  });
  const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'Alpha',
    acceptanceCriteria: ['x'],
    areas: ['src'],
  });
  return { project, task };
}

describe('PATCH /tasks/:id areas', () => {
  it('sets the areas of a task that has not started and keeps its id', async () => {
    const { task } = await seed();
    const res = await patch(`/tasks/${task.id}`, { areas: ['docs'] });
    expect(res.status).toBe(200);
    expect(TaskDto.parse(res.body)).toMatchObject({ id: task.id, areas: ['docs'] });
  });

  it('refuses an area the project does not have, naming it', async () => {
    const { task } = await seed();
    const res = await patch(`/tasks/${task.id}`, { areas: ['docs', 'billing'] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('billing');
  });

  it('refuses a task that has started, saying why', async () => {
    const { task } = await seed();
    await api().post(`/tasks/${task.id}/start`, z.unknown(), {});
    const res = await patch(`/tasks/${task.id}`, { areas: ['docs'] });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('has already started, so its areas are fixed');
  });
});
