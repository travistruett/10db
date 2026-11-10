import {
  Delivery,
  ProjectDto,
  TaskDto,
  TaskId,
  TaskMessageAuthor,
  TaskMessageDto,
} from '@10db/contracts';
import { insertSystemNotice, listTaskThread } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningDaemon } from '../src/daemon';
import { offerToAgent } from '../src/delivery';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

// Workbench spec D19: a failed check or a review finding is offered with Send to Agent and never
// sent by itself. The builder's click sends the notice's text as the builder's own message; a notice
// that offers nothing is refused.

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('send to agent');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    caps: { global: 0 },
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

async function task(): Promise<TaskId> {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    delivery: Delivery.Local,
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
  const made = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'Settings page',
    acceptanceCriteria: ['x'],
    areas: ['src'],
  });
  return TaskId.parse(made.id);
}

const send = (taskId: TaskId, messageId: string) =>
  fetch(`${daemon.url}/tasks/${taskId}/thread/${messageId}/send-to-agent`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}` },
  });

describe('POST /tasks/:taskId/thread/:messageId/send-to-agent', () => {
  it("sends an offered notice's text as the builder's message", async () => {
    const taskId = await task();
    const finding = 'Review finding: MAJOR src/a.ts:3 the title is wrong';
    const notice = daemon.state.write((ctx) => {
      const made = insertSystemNotice(ctx, taskId, finding);
      offerToAgent(ctx, made.id, finding);
      return made;
    });

    const res = await send(taskId, notice.id);

    expect(res.status).toBe(201);
    const sent = TaskMessageDto.parse(await res.json());
    expect(sent).toMatchObject({ author: TaskMessageAuthor.Builder, body: finding });
    expect(listTaskThread(daemon.state.db, taskId).map((m) => [m.author, m.body])).toEqual([
      [TaskMessageAuthor.System, finding],
      [TaskMessageAuthor.Builder, finding],
    ]);
  });

  it('refuses a notice that offers nothing to send, and an unknown one, sending nothing', async () => {
    const taskId = await task();
    const plain = daemon.state.write((ctx) => insertSystemNotice(ctx, taskId, 'A fresh session.'));

    expect((await send(taskId, plain.id)).status).toBe(409);
    expect((await send(taskId, 'checks')).status).toBe(409);
    expect(
      listTaskThread(daemon.state.db, taskId).filter((m) => m.author === TaskMessageAuthor.Builder),
    ).toEqual([]);
  });
});
