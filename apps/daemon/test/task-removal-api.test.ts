import {
  BoardColumnDto,
  DaemonEvent,
  EventType,
  ProjectDto,
  TaskDto,
  TaskStatus,
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
beforeEach(async () => {
  data = tempDir('task removal');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
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

const api = () => apiClient(daemon.url, daemon.token);

async function send(method: 'POST', path: string) {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
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

async function seedTask(projectId: string, title: string) {
  return api().post(`/projects/${projectId}/tasks`, TaskDto, {
    title,
    acceptanceCriteria: ['x'],
    areas: ['src'],
    dependsOn: [],
  });
}

const tasksOf = (projectId: string) =>
  api().get(`/projects/${projectId}/tasks`, taskListOf(projectId));
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
});
