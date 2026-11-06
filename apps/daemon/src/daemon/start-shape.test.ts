import {
  AccountCreatedDto,
  BRAINSTORM_REFUSED_ON_CHATGPT,
  GoalDto,
  ProjectDto,
  ShapeConvertResult,
  ShapeDto,
  ShapeMessageDto,
  ShapeViewDto,
  TaskDto,
  WorkstreamDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiClient } from '../../test/api-client';
import { createTempRepo, tempDir, waitForAsync } from '../../test/fixtures';
import { FakeAdapter, scriptedShapeBehaviour } from '../sessions';
import { startDaemon, type RunningDaemon } from './index';

// Shape through a started daemon on the fake adapter: the routes, the session's MCP tools and Convert,
// as the e2e drives them.

let dir: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
beforeEach(() => {
  dir = tempDir('daemon');
  repo = createTempRepo();
  daemon = null;
});
afterEach(async () => {
  await daemon?.stop();
  repo.cleanup();
  dir.cleanup();
});

async function startOnTheFake(): Promise<ReturnType<typeof apiClient>> {
  const adapter = new FakeAdapter({});
  adapter.shapeBehaviour = scriptedShapeBehaviour();
  daemon = await startDaemon({
    sandbox: null,
    dataDir: dir.path,
    port: 0,
    adapter,
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
  });
  return apiClient(daemon.url, daemon.token);
}

describe('a Shape conversation on a ChatGPT account', () => {
  it('is refused while the project is on one, and starts again once it is back on a Claude plan', async () => {
    const api = await startOnTheFake();
    const project = await api.post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const claudePlan = project.accountId;
    const { account: chatgpt } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'codex_signin',
      label: 'ChatGPT plan',
    });
    const shape = await api.post(`/projects/${project.id}/shapes`, ShapeDto, {});
    await api.patch(`/projects/${project.id}`, ProjectDto, { accountId: chatgpt.id });

    const words = new RegExp(`-> 400: .*${BRAINSTORM_REFUSED_ON_CHATGPT}`);
    await expect(api.post(`/projects/${project.id}/shapes`, ShapeDto, {})).rejects.toThrow(words);
    await expect(
      api.post(`/shapes/${shape.id}/messages`, ShapeMessageDto, { text: 'Make the cards denser.' }),
    ).rejects.toThrow(words);
    const refused = await api.get(`/shapes/${shape.id}`, ShapeViewDto);
    expect(refused.messages).toEqual([]);
    expect(refused.turn.running).toBe(false);

    await api.patch(`/projects/${project.id}`, ProjectDto, { accountId: claudePlan });
    await api.post(`/shapes/${shape.id}/messages`, ShapeMessageDto, {
      text: 'Make the cards denser.',
    });
    const talked = await waitForAsync(async () => {
      const view = await api.get(`/shapes/${shape.id}`, ShapeViewDto);
      return !view.turn.running && view.messages.some((m) => m.author === 'claude') ? view : false;
    });
    expect(talked.messages.some((m) => m.kind === 'notice')).toBe(false);
  });
});

describe('a Shape conversation on a started daemon', () => {
  it('is talked through, proposed and converted over HTTP, starting nothing', async () => {
    const api = await startOnTheFake();
    const project = await api.post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });

    const shape = await api.post(`/projects/${project.id}/shapes`, ShapeDto, {});
    expect(shape.title).toBe('New conversation');
    expect(await api.get(`/projects/${project.id}/shapes`, z.array(ShapeDto))).toHaveLength(1);

    const sent = await api.post(`/shapes/${shape.id}/messages`, ShapeMessageDto, {
      text: 'Make the cards denser.\nAnd thin the scrollbars.',
    });
    expect(sent.author).toBe('builder');

    const talked = await waitForAsync(async () => {
      const view = await api.get(`/shapes/${shape.id}`, ShapeViewDto);
      return !view.turn.running &&
        view.messages.some((m) => m.author === 'claude' && m.kind === 'text')
        ? view
        : false;
    });
    expect(talked.shape.title).toBe('Make the cards denser.');
    expect(talked.heard).toEqual(['Make the cards denser', 'And thin the scrollbars']);
    expect(talked.proposals).toEqual([]);

    expect(await api.post(`/shapes/${shape.id}/propose`, z.object({ status: z.string() }))).toEqual(
      { status: 'started' },
    );
    const proposed = await waitForAsync(async () => {
      const view = await api.get(`/shapes/${shape.id}`, ShapeViewDto);
      return !view.turn.running && view.proposals.length > 0 ? view : false;
    });
    expect(proposed.shape.round).toBe(1);
    expect(proposed.proposals.map((p) => p.kind).sort()).toEqual([
      'decision',
      'goal',
      'task',
      'task',
    ]);

    const converted = await api.post(`/shapes/${shape.id}/convert`, ShapeConvertResult, {
      proposalIds: proposed.proposals.map((p) => p.id),
    });
    expect(converted.createdNow).toBe(4);

    const after = await api.get(`/shapes/${shape.id}`, ShapeViewDto);
    expect(after.proposals.every((p) => p.state === 'accepted' && p.converted !== null)).toBe(true);
    expect(after.shape.state).toBe('converted');
    expect(await api.get(`/projects/${project.id}/tasks`, z.array(TaskDto))).toHaveLength(4);
    expect(await api.get('/workstreams?active=false', z.array(WorkstreamDto))).toEqual([]);
    const goalId = after.proposals.find((p) => p.kind === 'goal')?.converted?.goalId ?? '';
    expect((await api.get(`/goals/${goalId}`, GoalDto)).title).toBe('Board polish');
  });

  it('answers 404 for an unknown conversation and 401 without the token', async () => {
    await startOnTheFake();
    const unknown = await fetch(`${daemon?.url ?? ''}/shapes/shp_00000000000000000000000000`, {
      headers: { Authorization: `Bearer ${daemon?.token ?? ''}` },
    });
    expect([400, 404]).toContain(unknown.status);
    expect((await fetch(`${daemon?.url ?? ''}/shapes/x`)).status).toBe(401);
  });
});
