import { BuilderToolName, ProjectDto, TaskDto } from '@10db/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import { createTempRepo, tempDir } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
let client: Client;
beforeEach(async () => {
  data = tempDir('task placement');
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
    flowId: await quickFlowId(a),
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
  readonly riskTags?: string[];
  readonly workspaceMode?: 'shared' | 'worktree';
}
const base = { title: 'Alpha', acceptanceCriteria: ['it exists'] };

/** Makes the same task through the task API and through the builder MCP's create_task. */
async function makeBoth(projectId: string, made: Made) {
  const viaApi = await api().post(`/projects/${projectId}/tasks`, TaskDto, { ...base, ...made });
  const result = await client.callTool({
    name: BuilderToolName.CreateTask,
    arguments: { projectId, ...base, ...made },
  });
  const text = Text.parse(result.content)
    .map((c) => c.text)
    .join('');
  if (result.isError === true) throw new Error(text);
  const { id } = Created.parse(JSON.parse(text));
  return { viaApi, viaMcp: await taskById(projectId, id) };
}

async function taskById(projectId: string, id: string) {
  const found = (await api().get(`/projects/${projectId}/tasks`, z.array(TaskDto))).find(
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
    ['a migration risk tag', { areas: ['app'], riskTags: ['migration'] }, MIGRATIONS],
    [
      'a dependency risk tag, though shared is asked for',
      { areas: ['app'], riskTags: ['dependency'], workspaceMode: 'shared' },
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

  it('keeps a reason after the isolate list changes', async () => {
    const { id } = await project();
    const { viaApi } = await makeBoth(id, { areas: ['migrations'] });
    await api().patch(`/projects/${id}`, ProjectDto, { isolate: [] });
    expect(await taskById(id, viaApi.id)).toMatchObject(MIGRATIONS);
  });

  it('gives a project with local delivery shared tasks, whatever is asked', async () => {
    const { id } = await project({ delivery: 'local', prTitlePrefix: undefined });
    const { viaApi, viaMcp } = await makeBoth(id, {
      areas: ['migrations'],
      riskTags: ['migration'],
      workspaceMode: 'worktree',
    });
    for (const made of [viaApi, viaMcp])
      expect(made).toMatchObject({ workspaceMode: 'shared', placementReason: null });
  });

  it('lets the builder override a proposed copy from the placement control, with a reason saying so', async () => {
    const { id } = await project();
    const { viaApi } = await makeBoth(id, { areas: ['migrations'] });
    const overridden = await api().patch(`/tasks/${viaApi.id}`, TaskDto, {
      workspaceMode: 'shared',
    });
    expect(overridden).toMatchObject({
      workspaceMode: 'shared',
      placementReason: 'chosen by the builder',
    });
  });
});
