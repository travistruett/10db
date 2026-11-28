import { BuilderToolName, ProjectDto, TaskDto } from '@10db/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { taskListOf } from './task-list';
import { createTempRepo, tempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
let client: Client;
beforeEach(async () => {
  data = tempDir('task placement');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    tickMs: 3_600_000,
  });
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${daemon.url}/builder/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${daemon.token}` } },
    }),
  );
});
afterEach(async () => {
  await client.close();
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);
const Text = z.array(z.object({ type: z.literal('text'), text: z.string() }));
const Created = z.object({ id: z.string() });

async function project(extra: Record<string, unknown> = {}) {
  const a = api();
  return a.post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    defaultRigor: 'light',
    areas: [
      { name: 'app', globs: ['app/**'] },
      { name: 'contracts', globs: ['contracts/**'] },
    ],
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
    ...extra,
  });
}

interface Made {
  readonly areas: string[];
  /** The keys of the kinds the task is made with. */
  readonly kinds?: string[];
  readonly workspaceMode?: 'shared' | 'worktree';
}
const base = { title: 'Alpha', acceptanceCriteria: ['it exists'] };

/** Makes the same task through the task API and through the builder MCP's create_task. */
async function makeBoth(projectId: string, made: Made) {
  const { kinds = [], ...rest } = made;
  const viaApi = await api().post(`/projects/${projectId}/tasks`, TaskDto, {
    ...base,
    ...rest,
    kinds: kinds.map((key) => ({ key, source: 'builder' })),
  });
  const result = await client.callTool({
    name: BuilderToolName.CreateTask,
    arguments: { projectId, ...base, ...rest, kinds: kinds.map((key) => ({ key })) },
  });
  const text = Text.parse(result.content)
    .map((c) => c.text)
    .join('');
  if (result.isError === true) throw new Error(text);
  const { id } = Created.parse(JSON.parse(text));
  return { viaApi, viaMcp: await taskById(projectId, id) };
}

async function taskById(projectId: string, id: string) {
  const found = (await api().get(`/projects/${projectId}/tasks`, taskListOf(projectId))).find(
    (t) => t.id === id,
  );
  if (!found) throw new Error(`no task ${id}`);
  return found;
}

const MIGRATIONS = { workspaceMode: 'worktree', placementReason: 'touches migrations' };

describe('the placement proposed when a task is made', () => {
  it.each([
    [
      'a task with no match',
      { areas: ['app'] },
      { workspaceMode: 'shared', placementReason: null },
    ],
    ['an isolated hazard area', { areas: ['migrations'] }, MIGRATIONS],
    [
      'an isolated hazard area, though shared is asked for',
      { areas: ['migrations'], workspaceMode: 'shared' },
      MIGRATIONS,
    ],
    ['a migration kind', { areas: ['app'], kinds: ['migration'] }, MIGRATIONS],
    [
      'a dependency kind, though shared is asked for',
      { areas: ['app'], kinds: ['dependency'], workspaceMode: 'shared' },
      { workspaceMode: 'worktree', placementReason: 'touches dependencies' },
    ],
    [
      'an explicit copy for a task with no match',
      { areas: ['app'], workspaceMode: 'worktree' },
      { workspaceMode: 'worktree', placementReason: null },
    ],
    [
      'a contracts area with the stock isolate list',
      { areas: ['contracts'] },
      { workspaceMode: 'shared', placementReason: null },
    ],
  ] as const)(
    'is the same through the API and create_task for %s',
    async (_name, made, expected) => {
      const { id } = await project();
      const { viaApi, viaMcp } = await makeBoth(id, made as unknown as Made);
      expect(viaApi).toMatchObject(expected);
      expect(viaMcp).toMatchObject(expected);
    },
  );

  it("follows the project's default and its isolate list, which the project API reads and changes", async () => {
    const created = await project({ workspaceMode: 'worktree' });
    expect(created.isolate).toEqual(['migrations', 'deps']);
    const task = { areas: ['contracts'] };
    expect((await makeBoth(created.id, task)).viaApi).toMatchObject({
      workspaceMode: 'worktree',
      placementReason: null,
    });
    const changed = await api().patch(`/projects/${created.id}`, ProjectDto, {
      workspaceMode: 'shared',
      isolate: ['migrations', 'deps', 'contracts'],
    });
    expect(changed.isolate).toEqual(['migrations', 'deps', 'contracts']);
    const listed = (await api().get('/projects', z.array(ProjectDto))).find(
      (p) => p.id === created.id,
    );
    expect(listed?.isolate).toEqual(['migrations', 'deps', 'contracts']);
    const { viaApi, viaMcp } = await makeBoth(created.id, task);
    for (const made of [viaApi, viaMcp])
      expect(made).toMatchObject({
        workspaceMode: 'worktree',
        placementReason: 'touches contracts',
      });
  });
});
