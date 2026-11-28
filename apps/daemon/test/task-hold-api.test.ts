import {
  BoardStatus,
  DaemonEvent,
  EventType,
  ProjectDto,
  TaskDto,
  TaskStatus,
  WorkstreamDto,
  WorkstreamState as S,
} from '@10db/contracts';
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
/** No lane is free until a test raises it, so a started task stays queued. */
const caps = { global: 0 };
beforeEach(async () => {
  data = tempDir('task hold');
  caps.global = 0;
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
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

async function startedTask() {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
  const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'held',
    acceptanceCriteria: ['x'],
    areas: ['src'],
  });
  const run = await api().post(`/tasks/${task.id}/start`, WorkstreamDto);
  return { project, task, run };
}

const taskOf = async (projectId: string, id: string) =>
  (await api().get(`/projects/${projectId}/tasks`, taskListOf(projectId))).find((t) => t.id === id);

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
});
