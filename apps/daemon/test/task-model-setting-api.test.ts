import { ProjectDto, TaskDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('task model setting');
  repo = createTempRepo();
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
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

const api = () => apiClient(daemon.url, daemon.token);

const seedProject = () =>
  api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });

const strongest = { kind: 'tier', tier: 'capable' } as const;

describe('a task’s own setting', () => {
  it('is set and removed by patching the task', async () => {
    const project = await seedProject();
    const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['x'],
      areas: ['src'],
    });
    expect(task.modelSetting).toBeNull();
    const set = await api().patch(`/tasks/${task.id}`, TaskDto, { modelSetting: strongest });
    expect(set.modelSetting).toEqual(strongest);
    const cleared = await api().patch(`/tasks/${task.id}`, TaskDto, { modelSetting: null });
    expect(cleared.modelSetting).toBeNull();
  });
});
