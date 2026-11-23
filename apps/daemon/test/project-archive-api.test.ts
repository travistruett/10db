import { ProjectDto, TaskDto } from '@10db/contracts';
import { insertWorkstream, transitionWorkstream } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { createMemoryKeychain, createTempRepo, tempDir } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;

beforeEach(async () => {
  data = tempDir('project archive');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    keychain: createMemoryKeychain(),
    caffeinate: () => null,
    watch: false,
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const post = (path: string) =>
  fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
  });

describe('archiving a project through the API', () => {
  it('is refused while a task runs, and hides the project once the work is done', async () => {
    const api = apiClient(daemon.url, daemon.token);
    const project = await api.post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      defaultRigor: 'light',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['it works'],
      areas: ['src'],
    });
    const lane = daemon.state.write((ctx) =>
      insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    );

    const refused = await post(`/projects/${project.id}/archive`);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('1 task in progress');
    expect(await api.get('/projects', z.array(ProjectDto))).toHaveLength(1);

    daemon.state.write((ctx) => {
      transitionWorkstream(ctx, lane.id, { to: 'CANCELLED', fence: null });
    });
    expect((await post(`/projects/${project.id}/archive`)).status).toBe(204);
    expect(await api.get('/projects', z.array(ProjectDto))).toEqual([]);
    expect((await api.get('/projects/archived', z.array(ProjectDto))).map((p) => p.id)).toEqual([
      project.id,
    ]);

    // Adding the same folder again says where to restore it from, not that a constraint failed.
    const again = await fetch(`${daemon.url}/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'again',
        repoPath: repo.path,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
      }),
    });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('restore it from Settings');

    expect((await post(`/projects/${project.id}/restore`)).status).toBe(204);
    expect(await api.get('/projects', z.array(ProjectDto))).toHaveLength(1);
  });
});
