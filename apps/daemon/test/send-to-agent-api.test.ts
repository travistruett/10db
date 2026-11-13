import {
  Delivery,
  PassOpenedDto,
  ProjectDto,
  TakeOutStep,
  TaskDto,
  TaskId,
  TaskMessageAuthor,
  TaskMessageDto,
} from '@10db/contracts';
import {
  advanceTakeOut,
  insertSystemNotice,
  insertTakeOut,
  listTaskThread,
  offerAllowThis,
  offerToAgent,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { checkNoticeLine, checkOffer } from '../src/runner/check-targets';
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
    adapter: new FakeAdapter({
      'Settings: tidy': [[{ do: 'consume' }, { do: 'await_message', contains: 'never sent' }]],
    }),
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
    // Sent once: the notice offers nothing more, and a second send is refused.
    expect(listTaskThread(daemon.state.db, taskId).find((m) => m.id === notice.id)?.sendable).toBe(
      false,
    );
    expect((await send(taskId, notice.id)).status).toBe(409);
  });

  it("sends a failed turn check's offer whole, however long the check's output was", async () => {
    const taskId = await task();
    const line = checkNoticeLine(['src/settings/page.tsx']);
    const offer = checkOffer({
      line,
      command: 'make check-changed',
      exitCode: 2,
      output: `${'src/settings/page.tsx:1:1 - error TS2322\n'.repeat(2000)}Found 2000 errors.\n`,
    });
    const notice = daemon.state.write((ctx) => {
      const made = insertSystemNotice(ctx, taskId, line);
      offerToAgent(ctx, made.id, offer);
      return made;
    });

    const res = await send(taskId, notice.id);

    expect(res.status).toBe(201);
    expect(TaskMessageDto.parse(await res.json())).toMatchObject({
      author: TaskMessageAuthor.Builder,
      body: offer,
    });
    expect(offer.endsWith('Found 2000 errors.\n```')).toBe(true);
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

describe('Allow this', () => {
  const GO_AHEAD =
    'I approve this exact Bash call. Run it again as it was:\n\n```\nnpx vercel deploy\n```';

  /** A page of an open pass, with a denied call's notice offered with Allow this. */
  async function pageWithDenial() {
    const project = await api().post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: null,
      areas: [
        { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
        { name: 'src', globs: ['src/**'], role: 'shared' },
      ],
    });
    const page = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Settings: tidy',
      acceptanceCriteria: ['x'],
      areas: ['settings'],
      dependsOn: [],
    });
    const opened = await api().post(`/projects/${project.id}/passes`, PassOpenedDto, {
      name: 'Polish',
      taskIds: [page.id],
    });
    const notice = denial(TaskId.parse(page.id));
    return { taskId: TaskId.parse(page.id), passId: opened.pass.id, notice };
  }

  const denial = (taskId: TaskId) =>
    daemon.state.write((ctx) => {
      const made = insertSystemNotice(ctx, taskId, 'Auto mode stopped this Bash call');
      offerAllowThis(ctx, made.id, GO_AHEAD);
      return made;
    });
  const builderMessages = (taskId: TaskId) =>
    listTaskThread(daemon.state.db, taskId)
      .filter((m) => m.author === TaskMessageAuthor.Builder)
      .map((m) => m.body);

  it("sends the go-ahead to an open pass's page once", async () => {
    const { taskId, notice } = await pageWithDenial();

    const res = await send(taskId, notice.id);

    expect(res.status).toBe(201);
    expect(TaskMessageDto.parse(await res.json())).toMatchObject({
      author: TaskMessageAuthor.Builder,
      body: GO_AHEAD,
    });
    expect(listTaskThread(daemon.state.db, taskId).find((m) => m.id === notice.id)).toMatchObject({
      sendable: false,
      allowThis: false,
    });
    expect((await send(taskId, notice.id)).status).toBe(409);
    expect(builderMessages(taskId)).toEqual([GO_AHEAD]);
  });

  it('refuses the go-ahead with 409 once the pass is gone, sending nothing', async () => {
    const { taskId, passId, notice } = await pageWithDenial();
    await api().post(`/passes/${passId}/abandon`, z.unknown());

    const res = await send(taskId, notice.id);

    // Leaving the pass took the offer with it, so the notice offers nothing to send.
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('That notice offers nothing to send to the agent');
    expect(listTaskThread(daemon.state.db, taskId).find((m) => m.id === notice.id)).toMatchObject({
      allowThis: false,
    });
    expect(builderMessages(taskId)).toEqual([]);
  });

  it('refuses the go-ahead with 409 for a task that is not a page of an open pass', async () => {
    const outside = await task();
    const notice = denial(outside);

    const res = await send(outside, notice.id);

    expect(res.status).toBe(409);
    expect(await res.text()).toContain('That go-ahead can only go to a page of an open pass');
    expect(builderMessages(outside)).toEqual([]);
  });

  it('puts the offer back when the send fails, and the next send posts', async () => {
    const { taskId, passId, notice } = await pageWithDenial();
    daemon.state.write((ctx) => insertTakeOut(ctx, { taskId, passId, drops: [] }));

    const refused = await send(taskId, notice.id);

    expect(refused.status).toBe(409);
    expect(listTaskThread(daemon.state.db, taskId).find((m) => m.id === notice.id)).toMatchObject({
      sendable: true,
      allowThis: true,
    });
    daemon.state.write((ctx) =>
      advanceTakeOut(ctx, { taskId, passId }, { step: TakeOutStep.Done }),
    );
    expect((await send(taskId, notice.id)).status).toBe(201);
    expect(builderMessages(taskId)).toEqual([GO_AHEAD]);
  });
});
