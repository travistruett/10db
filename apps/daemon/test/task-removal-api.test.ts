import {
  BoardColumnDto,
  DaemonEvent,
  EventType,
  ProjectDto,
  TaskDto,
  TaskStatus,
  WorkstreamDto,
  mintId,
} from '@10db/contracts';
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
  data = tempDir('task removal');
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

async function send(method: 'GET' | 'POST' | 'PATCH', path: string, body: unknown = {}) {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
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

const tasksOf = (projectId: string) => api().get(`/projects/${projectId}/tasks`, z.array(TaskDto));
const eventsAfter = (seq: number) =>
  api().get(`/events?after=${String(seq)}`, z.array(DaemonEvent));

describe('POST /tasks/:id/remove', () => {
  it('cancels an unstarted task, emits task.changed, hides it from the list and keeps the row', async () => {
    const project = await seedProject();
    const keep = await seedTask(project.id, 'keep');
    const gone = await seedTask(project.id, 'gone');
    const head = await api().get('/events/head', z.object({ seq: z.number() }));

    const res = await send('POST', `/tasks/${gone.id}/remove`);

    expect(res.status).toBe(200);
    expect(TaskDto.parse(res.body)).toMatchObject({ id: gone.id, status: TaskStatus.Cancelled });
    expect((await tasksOf(project.id)).map((t) => t.id)).toEqual([keep.id]);
    const changed = (await eventsAfter(head.seq)).filter((e) => e.entityId === gone.id);
    expect(changed).toEqual([
      expect.objectContaining({
        type: EventType.TaskChanged,
        entityType: 'task',
        data: { status: 'cancelled' },
      }),
    ]);
    const row = daemon.state.db.$client
      .prepare('select status, title from tasks where id = ?')
      .get(gone.id);
    expect(row).toEqual({ status: 'cancelled', title: 'gone' });
  });

  it('removes a parked task', async () => {
    const project = await seedProject();
    const task = await seedTask(project.id, 'parked');
    const column = await api().post(`/projects/${project.id}/board-columns`, BoardColumnDto, {
      name: 'Later',
    });
    await api().post(`/tasks/${task.id}/move`, TaskDto, {
      to: column.id,
      after: null,
      before: null,
    });
    expect((await send('POST', `/tasks/${task.id}/remove`)).status).toBe(200);
    expect(await tasksOf(project.id)).toEqual([]);
  });

  it('is idempotent: a second remove answers 200 with the same task and emits nothing', async () => {
    const project = await seedProject();
    const task = await seedTask(project.id, 'twice');
    await send('POST', `/tasks/${task.id}/remove`);
    const head = (await api().get('/events/head', z.object({ seq: z.number() }))).seq;
    const again = await send('POST', `/tasks/${task.id}/remove`);
    expect(again.status).toBe(200);
    expect(TaskDto.parse(again.body).status).toBe('cancelled');
    expect(await eventsAfter(head)).toEqual([]);
  });

  it('answers 404 for an unknown task', async () => {
    const res = await send('POST', `/tasks/${mintId('Task')}/remove`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  it('answers 400 for a malformed id', async () => {
    expect((await send('POST', '/tasks/not-an-id/remove')).status).toBe(400);
  });

  it.each([
    { name: 'a started task', cancelRun: false },
    { name: 'a task whose workstream was cancelled', cancelRun: true },
  ])('refuses $name with 409 naming the workstream cancel', async ({ cancelRun }) => {
    const project = await seedProject();
    const task = await seedTask(project.id, 'started');
    const started = await api().post(`/tasks/${task.id}/start`, WorkstreamDto);
    if (cancelRun) await api().post(`/workstreams/${started.id}/cancel`, WorkstreamDto);

    const res = await send('POST', `/tasks/${task.id}/remove`);

    expect(res.status).toBe(409);
    const error = ConflictBody.parse(res.body);
    expect(error.error).toBe('conflict');
    expect(error.message.includes(`/workstreams/${started.id}/cancel`)).toBe(!cancelRun);
    expect(error.message).toContain(started.id);
    expect((await tasksOf(project.id)).map((t) => [t.id, t.status])).toEqual([[task.id, 'open']]);
  });

  it('refuses a task an open task waits on, naming the dependent', async () => {
    const project = await seedProject();
    const base = await seedTask(project.id, 'base');
    await seedTask(project.id, 'child', [base.id]);
    const res = await send('POST', `/tasks/${base.id}/remove`);
    expect(res.status).toBe(409);
    expect(ConflictBody.parse(res.body).message).toContain('child');
    expect(await tasksOf(project.id)).toHaveLength(2);
  });

  it('keeps a removed task from being edited, moved or started', async () => {
    const project = await seedProject();
    const task = await seedTask(project.id, 'gone');
    await send('POST', `/tasks/${task.id}/remove`);
    const other = await seedTask(project.id, 'other');
    expect(
      (await send('POST', `/tasks/${task.id}/move`, { to: null, after: other.id, before: null }))
        .status,
    ).toBe(409);
    expect(
      (
        await send('POST', `/projects/${project.id}/tasks`, {
          title: 't',
          acceptanceCriteria: ['x'],
          areas: ['src'],
          dependsOn: [task.id],
        })
      ).status,
    ).toBe(400);
    expect((await send('PATCH', `/tasks/${task.id}`, { title: 'new' })).status).toBe(409);
    expect((await send('POST', `/tasks/${task.id}/start`)).status).toBe(409);
  });
});
