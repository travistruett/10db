import {
  BoardStatus,
  DaemonEvent,
  EventType,
  ProjectDto,
  TaskDto,
  TaskStatus,
  WorkstreamDto,
  WorkstreamState as S,
  mintId,
} from '@10db/contracts';
import { transitionWorkstream } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir, waitForAsync } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
/** No lane is free until a test raises it, so a started task stays queued. */
const caps = { global: 0 };
beforeEach(async () => {
  data = tempDir('task hold');
  caps.global = 0;
  repo = createTempRepo();
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    caps,
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

async function send(path: string) {
  const res = await fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

async function startedTask(title = 'held') {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
  const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title,
    acceptanceCriteria: ['x'],
    areas: ['src'],
  });
  const run = await api().post(`/tasks/${task.id}/start`, WorkstreamDto);
  return { project, task, run };
}

const taskOf = async (projectId: string, id: string) =>
  (await api().get(`/projects/${projectId}/tasks`, z.array(TaskDto))).find((t) => t.id === id);

const runState = (id: string) =>
  daemon.state.db.$client.prepare('select state from workstreams where id = ?').get(id);

describe('POST /tasks/:id/hold', () => {
  it('holds a queued task: the run is HELD, the task shows blocked and the event says so', async () => {
    const { project, task, run } = await startedTask();
    expect(run.state).toBe(S.Queued);
    const head = await api().get('/events/head', z.object({ seq: z.number() }));

    const res = await send(`/tasks/${task.id}/hold`);

    expect(res.status).toBe(200);
    expect(WorkstreamDto.parse(res.body)).toMatchObject({ id: run.id, state: S.Held });
    expect(await taskOf(project.id, task.id)).toMatchObject({
      status: TaskStatus.Open,
      boardStatus: BoardStatus.Blocked,
      workstreamId: run.id,
    });
    const events = await api().get(`/events?after=${String(head.seq)}`, z.array(DaemonEvent));
    expect(events.filter((e) => e.type === EventType.WorkstreamChanged)).toEqual([
      expect.objectContaining({
        entityId: run.id,
        data: { from: S.Queued, to: S.Held, reason: 'held by the builder' },
      }),
    ]);
  });

  it('keeps a held run out of the queue: a tick leaves it held and no lane starts', async () => {
    const { task, run } = await startedTask();
    await send(`/tasks/${task.id}/hold`);
    caps.global = 4;
    // The first tick can be spent preparing the account, so tick a few times with a lane free.
    for (let i = 0; i < 3; i++) await daemon.scheduler.tick();
    expect(runState(run.id)).toEqual({ state: S.Held });
  });

  it('answers 409 for a task that has begun running, naming the task', async () => {
    const { task, run } = await startedTask('Busy one');
    daemon.state.write((ctx) => transitionWorkstream(ctx, run.id, { to: S.Starting, fence: null }));
    const res = await send(`/tasks/${task.id}/hold`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'conflict' });
    expect(JSON.stringify(res.body)).toContain('Busy one');
    expect(runState(run.id)).toEqual({ state: S.Starting });
  });

  it('answers 409 for a task that was never started', async () => {
    const project = await api().post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'fresh',
      acceptanceCriteria: ['x'],
      areas: ['src'],
    });
    expect((await send(`/tasks/${task.id}/hold`)).status).toBe(409);
  });

  it('answers 404 for an unknown task and 400 for a malformed id', async () => {
    expect((await send(`/tasks/${mintId('Task')}/hold`)).status).toBe(404);
    expect((await send('/tasks/not-an-id/hold')).status).toBe(400);
  });
});

describe('starting a held task', () => {
  it('queues the same run again and a tick gives it a lane', async () => {
    const { project, task, run } = await startedTask();
    await send(`/tasks/${task.id}/hold`);

    const res = await send(`/tasks/${task.id}/start`);

    expect(res.status).toBe(201);
    expect(WorkstreamDto.parse(res.body)).toMatchObject({ id: run.id, state: S.Queued });
    expect((await taskOf(project.id, task.id))?.workstreamId).toBe(run.id);
    caps.global = 4;
    // The first ticks can be spent preparing the account, so tick until the run leaves the queue.
    const left = await waitForAsync(async () => {
      await daemon.scheduler.tick();
      const row = runState(run.id) as { state: string };
      return row.state === S.Queued ? undefined : row.state;
    }, 20_000);
    expect(left).not.toBe(S.Held);
  });
});

describe('removing a held task', () => {
  it('cancels the held run and the task and hides it from the list', async () => {
    const { project, task, run } = await startedTask();
    await send(`/tasks/${task.id}/hold`);

    const res = await send(`/tasks/${task.id}/remove`);

    expect(res.status).toBe(200);
    expect(TaskDto.parse(res.body)).toMatchObject({ id: task.id, status: TaskStatus.Cancelled });
    expect(runState(run.id)).toEqual({ state: S.Cancelled });
    expect(await taskOf(project.id, task.id)).toBeUndefined();
  });
});
