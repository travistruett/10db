import {
  DaemonEvent,
  EventType,
  ProjectDto,
  TaskDto,
  TaskStatus,
  WorkstreamDto,
  WorkstreamState,
  mintId,
  type WorkstreamId,
  type WorkstreamState as State,
} from '@10db/contracts';
import { transitionWorkstream } from '@10db/db';
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
  data = tempDir('task close');
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

const ConflictBody = z.object({ error: z.string(), message: z.string() });

const api = () => apiClient(daemon.url, daemon.token);

async function send(path: string) {
  const res = await fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

async function seedProject() {
  return api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
}

async function seedTask(projectId: string, title: string, dependsOn: string[] = []) {
  return api().post(`/projects/${projectId}/tasks`, TaskDto, {
    title,
    acceptanceCriteria: ['x'],
    areas: ['src'],
    dependsOn,
  });
}

/** Starts the task, then walks its workstream to `to` the way the runner would. */
async function startAndMove(taskId: string, to: readonly State[]) {
  const started = await api().post(`/tasks/${taskId}/start`, WorkstreamDto);
  for (const next of to)
    daemon.state.write((ctx) => transitionWorkstream(ctx, started.id, { to: next, fence: null }));
  return started.id satisfies WorkstreamId;
}

/** A started workstream already sits in STARTING. */
const FAILED_PATH = [WorkstreamState.Running, WorkstreamState.Failed];

const tasksOf = (projectId: string) => api().get(`/projects/${projectId}/tasks`, z.array(TaskDto));
const eventsAfter = (seq: number) =>
  api().get(`/events?after=${String(seq)}`, z.array(DaemonEvent));

describe('POST /tasks/:id/close', () => {
  it('closes a task whose run failed: off the Board, run still in Factory, one task.changed', async () => {
    const project = await seedProject();
    const keep = await seedTask(project.id, 'keep');
    const stale = await seedTask(project.id, 'stale');
    const wsId = await startAndMove(stale.id, FAILED_PATH);
    const head = await api().get('/events/head', z.object({ seq: z.number() }));

    const res = await send(`/tasks/${stale.id}/close`);

    expect(res.status).toBe(200);
    expect(TaskDto.parse(res.body)).toMatchObject({ id: stale.id, status: TaskStatus.Cancelled });
    expect((await tasksOf(project.id)).map((t) => t.id)).toEqual([keep.id]);
    const history = await api().get('/workstreams?active=false', z.array(WorkstreamDto));
    expect(history.map((w) => [w.id, w.state])).toEqual([[wsId, WorkstreamState.Failed]]);
    const changed = (await eventsAfter(head.seq)).filter((e) => e.entityId === stale.id);
    expect(changed).toEqual([
      expect.objectContaining({
        type: EventType.TaskChanged,
        entityType: 'task',
        data: { status: 'cancelled' },
      }),
    ]);
  });

  it('keeps a closed task from being retried or started', async () => {
    const project = await seedProject();
    const stale = await seedTask(project.id, 'stale');
    const wsId = await startAndMove(stale.id, FAILED_PATH);
    await send(`/tasks/${stale.id}/close`);
    expect((await send(`/workstreams/${wsId}/retry`)).status).toBe(409);
    expect((await send(`/tasks/${stale.id}/start`)).status).toBe(409);
  });

  it('refuses a task an open task waits on, naming the dependents', async () => {
    const project = await seedProject();
    const base = await seedTask(project.id, 'base');
    await seedTask(project.id, 'child', [base.id]);
    await startAndMove(base.id, FAILED_PATH);
    const res = await send(`/tasks/${base.id}/close`);
    expect(res.status).toBe(409);
    expect(ConflictBody.parse(res.body).message).toContain('child');
    expect(await tasksOf(project.id)).toHaveLength(2);
  });

  it('refuses a task whose run is still live and a task that never started', async () => {
    const project = await seedProject();
    const running = await seedTask(project.id, 'running');
    const fresh = await seedTask(project.id, 'fresh');
    await startAndMove(running.id, []);
    expect((await send(`/tasks/${running.id}/close`)).status).toBe(409);
    expect((await send(`/tasks/${fresh.id}/close`)).status).toBe(409);
    expect(await tasksOf(project.id)).toHaveLength(2);
  });

  it('answers 404 for an unknown task and 400 for a malformed id', async () => {
    expect((await send(`/tasks/${mintId('Task')}/close`)).status).toBe(404);
    expect((await send('/tasks/not-an-id/close')).status).toBe(400);
  });
});
