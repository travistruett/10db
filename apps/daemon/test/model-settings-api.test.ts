import { ModelSettingsDto, ProjectDto, TaskDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('model settings');
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

async function send(method: string, path: string, body: unknown) {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

const seedProject = () =>
  api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });

const automatic = { kind: 'automatic' } as const;
const strongest = { kind: 'tier', tier: 'capable' } as const;

describe('the settings that apply everywhere', () => {
  it('start with the one seeded pattern and no role set', async () => {
    const settings = await api().get('/model-settings', ModelSettingsDto);
    expect(settings.roles).toEqual([]);
    expect(settings.patterns).toHaveLength(1);
    expect(settings.patterns[0]).toMatchObject({
      name: 'High-risk work',
      projectId: null,
      match: {
        riskTags: ['security', 'auth', 'migration'],
        roles: [],
        areas: [],
        retryOnly: false,
      },
      setting: { kind: 'top_of_tier' },
      position: 0,
    });
  });

  it('keep a role’s setting and the patterns in the order they were saved', async () => {
    const saved = await api().put('/model-settings', ModelSettingsDto, {
      roles: [
        { role: 'review', setting: strongest },
        { role: 'implement', setting: automatic },
      ],
      patterns: [
        { name: 'Second thought', setting: automatic },
        { name: 'First thought', match: { retryOnly: true }, setting: strongest },
      ],
    });
    expect(saved.patterns.map((p) => [p.name, p.position])).toEqual([
      ['Second thought', 0],
      ['First thought', 1],
    ]);
    const read = await api().get('/model-settings', ModelSettingsDto);
    expect(read.roles).toEqual(
      expect.arrayContaining([
        { role: 'review', projectId: null, setting: strongest },
        { role: 'implement', projectId: null, setting: automatic },
      ]),
    );
    expect(read.patterns.map((p) => p.name)).toEqual(['Second thought', 'First thought']);
    expect(read.patterns[1]?.match.retryOnly).toBe(true);
  });

  it('leave the patterns alone when a save names none', async () => {
    await api().put('/model-settings', ModelSettingsDto, {
      roles: [{ role: 'review', setting: strongest }],
    });
    expect((await api().get('/model-settings', ModelSettingsDto)).patterns).toHaveLength(1);
  });

  it('return a role to 10db’s default with null, which Automatic is not', async () => {
    await api().put('/model-settings', ModelSettingsDto, {
      roles: [
        { role: 'review', setting: strongest },
        { role: 'plan', setting: automatic },
      ],
    });
    const cleared = await api().put('/model-settings', ModelSettingsDto, {
      roles: [{ role: 'review', setting: null }],
    });
    expect(cleared.roles).toEqual([{ role: 'plan', projectId: null, setting: automatic }]);
    expect((await api().get('/model-settings', ModelSettingsDto)).roles).toEqual(cleared.roles);
  });
});

describe('a project’s own settings', () => {
  it('are separate from the global ones and go back to them with null', async () => {
    const project = await seedProject();
    const path = `/projects/${project.id}/model-settings`;
    await api().put('/model-settings', ModelSettingsDto, {
      roles: [{ role: 'review', setting: automatic }],
    });
    const none = await api().get(path, ModelSettingsDto);
    expect(none).toEqual({ roles: [], patterns: [] });
    const saved = await api().put(path, ModelSettingsDto, {
      roles: [{ role: 'review', setting: strongest }],
      patterns: [{ name: 'Billing', match: { areas: ['src'] }, setting: strongest }],
    });
    expect(saved.roles).toEqual([{ role: 'review', projectId: project.id, setting: strongest }]);
    expect(saved.patterns).toMatchObject([{ name: 'Billing', projectId: project.id }]);
    // A project's patterns leave the global list alone.
    expect(
      (await api().get('/model-settings', ModelSettingsDto)).patterns.map((p) => p.name),
    ).toEqual(['High-risk work']);
    expect(
      (await api().get('/model-settings', ModelSettingsDto)).roles.map((r) => r.setting),
    ).toEqual([automatic]);
    const cleared = await api().put(path, ModelSettingsDto, {
      roles: [{ role: 'review', setting: null }],
    });
    expect(cleared.roles).toEqual([]);
    expect(cleared.patterns).toHaveLength(1);
  });

  it('refuse a pattern naming an area the project does not have', async () => {
    const project = await seedProject();
    const refused = await send('PUT', `/projects/${project.id}/model-settings`, {
      roles: [],
      patterns: [{ name: 'Money', match: { areas: ['billing'] }, setting: strongest }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toContain('billing');
    expect(await api().get(`/projects/${project.id}/model-settings`, ModelSettingsDto)).toEqual({
      roles: [],
      patterns: [],
    });
  });

  it('are refused for a project that does not exist', async () => {
    const missing = await send(
      'GET',
      '/projects/prj_01900000-0000-7000-8000-000000000000/model-settings',
      undefined,
    );
    expect(missing.status).toBe(404);
  });
});

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
