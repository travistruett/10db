import {
  BatchDto,
  ProjectDto,
  TaskDto,
  WorkstreamDto,
  type InboxItemId,
  type ProjectId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getInboxItem,
  insertBatch,
  transitionBatch,
  transitionWorkstream,
  insertWorkstream,
} from '@10db/db';
import { flagCard } from '../src/inbox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir, waitForAsync } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('restart failed');
  repo = createTempRepo();
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    // A tick long enough that a queued run stays where the test left it.
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  // A start requests a tick; let it finish before the daemon closes its logger.
  await daemon.scheduler.idle();
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

async function startTask(taskId: TaskId, body: unknown) {
  const res = await fetch(`${daemon.url}/tasks/${taskId}/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

const batchesOf = (projectId: ProjectId) =>
  api().get(`/projects/${projectId}/batches`, z.array(BatchDto));

/**
 * A pull-request project with one task, Alpha, whose run FAILED in an OPEN batch of its own. Alpha
 * depends on an unstarted task of each title in `waitsOn`.
 */
async function failedInOpenBatch(waitsOn: readonly string[] = []) {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
  });
  const add = (title: string, dependsOn: readonly string[]) =>
    api().post(`/projects/${project.id}/tasks`, TaskDto, {
      title,
      acceptanceCriteria: ['x'],
      areas: ['src'],
      dependsOn,
    });
  const dependencies: string[] = [];
  for (const title of waitsOn) dependencies.push((await add(title, [])).id);
  const task = await add('Alpha', dependencies);
  const { batchId, workstreamId } = daemon.state.write((ctx) => {
    const batch = insertBatch(ctx, { projectId: project.id, title: 'Alpha', baseBranch: 'main' });
    transitionBatch(ctx, batch.id, { to: 'OPEN', patch: { branch: 'tendb/alpha' } });
    const ws = insertWorkstream(ctx, task.id, { batchId: batch.id });
    for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
      transitionWorkstream(ctx, ws.id, { to, fence: null });
    return { batchId: batch.id, workstreamId: ws.id };
  });
  return { project, task, batchId, workstreamId };
}

describe('POST /tasks/:id/start on a task whose run failed in an open batch', () => {
  it('reruns the same workstream in the same batch and makes no new batch', async () => {
    const { project, task, batchId, workstreamId } = await failedInOpenBatch();

    const res = await startTask(task.id, {});

    expect(res.status).toBe(201);
    expect(WorkstreamDto.parse(res.body)).toMatchObject({
      id: workstreamId,
      state: 'QUEUED',
      batchId,
    });
    const batches = await batchesOf(project.id);
    expect(batches.map((b) => [b.id, b.state])).toEqual([[batchId, 'OPEN']]);
    // The scheduler launches the queued run at once; cancel it so no lane outlives the daemon.
    await api().post(`/workstreams/${workstreamId}/cancel`, WorkstreamDto);
  });

  it('with fresh: true abandons that batch and starts the task in a new one', async () => {
    const { project, task, batchId } = await failedInOpenBatch();

    const res = await startTask(task.id, { fresh: true });

    expect(res.status).toBe(202);
    const fresh = BatchDto.parse(res.body);
    expect(fresh.id).not.toBe(batchId);
    const old = (await batchesOf(project.id)).find((b) => b.id === batchId);
    expect(old?.state).toBe('ABANDONED');
    // The repo has no origin, so the new batch's cut is refused; wait for it before the daemon stops.
    await waitForAsync(async () =>
      (await batchesOf(project.id)).every((b) => b.id !== fresh.id) ? true : undefined,
    );
  });

  const failedCard = (project: ProjectId, workstream: WorkstreamId): InboxItemId =>
    daemon.state.write((ctx) =>
      flagCard(ctx, {
        projectId: project,
        workstreamId: workstream,
        title: 'Workstream failed: Alpha',
        body: 'The gate failed',
      }),
    ).id;
  const cardState = (id: InboxItemId) => getInboxItem(daemon.state.db, id).state;

  it('closes the failed card when Start reruns the workstream', async () => {
    const { project, task, workstreamId } = await failedInOpenBatch();
    const card = failedCard(project.id, workstreamId);

    await startTask(task.id, {});

    expect(cardState(card)).not.toBe('OPEN');
    await api().post(`/workstreams/${workstreamId}/cancel`, WorkstreamDto);
  });

  it('closes the failed card when Start over abandons the batch', async () => {
    const { project, task, workstreamId } = await failedInOpenBatch();
    const card = failedCard(project.id, workstreamId);

    const res = await startTask(task.id, { fresh: true });

    expect(cardState(card)).not.toBe('OPEN');
    const fresh = BatchDto.parse(res.body);
    await waitForAsync(async () =>
      (await batchesOf(project.id)).every((b) => b.id !== fresh.id) ? true : undefined,
    );
  });

  it('closes the failed card when Start over begins a new run beside a done task in a shared batch', async () => {
    const project = await api().post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      areas: [
        { name: 'src', globs: ['src/**'] },
        { name: 'ui', globs: ['ui/**'] },
      ],
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
    });
    const add = (title: string, area: string) =>
      api().post(`/projects/${project.id}/tasks`, TaskDto, {
        title,
        acceptanceCriteria: ['x'],
        areas: [area],
      });
    const alpha = await add('Alpha', 'src');
    const beta = await add('Beta', 'ui');
    const { batchId, workstreamId } = daemon.state.write((ctx) => {
      const batch = insertBatch(ctx, { projectId: project.id, title: 'Both', baseBranch: 'main' });
      transitionBatch(ctx, batch.id, { to: 'OPEN', patch: { branch: 'tendb/both' } });
      const done = insertWorkstream(ctx, beta.id, { batchId: batch.id });
      for (const to of ['STARTING', 'RUNNING', 'VERIFYING', 'DONE'] as const)
        transitionWorkstream(ctx, done.id, { to, fence: null });
      const ws = insertWorkstream(ctx, alpha.id, { batchId: batch.id });
      for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
        transitionWorkstream(ctx, ws.id, { to, fence: null });
      return { batchId: batch.id, workstreamId: ws.id };
    });
    const card = failedCard(project.id, workstreamId);

    const res = await startTask(alpha.id, { fresh: true });

    expect(res.status).toBe(202);
    // The batch still holds Beta's work, so the new run joins it rather than continuing the old one.
    expect(BatchDto.parse(res.body).id).toBe(batchId);
    expect(cardState(card)).not.toBe('OPEN');
    const runs = await api().get('/workstreams?active=true', z.array(WorkstreamDto));
    const fresh = runs.filter((w) => w.taskId === alpha.id);
    expect(fresh.map((w) => w.id)).not.toContain(workstreamId);
    for (const w of fresh) await api().post(`/workstreams/${w.id}/cancel`, WorkstreamDto);
  });

  it('closes the failed card when Start begins a new run of a failed local-delivery task', async () => {
    const project = await api().post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      areas: [{ name: 'src', globs: ['src/**'] }],
      delivery: 'local',
    });
    const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['x'],
      areas: ['src'],
    });
    const workstreamId = daemon.state.write((ctx) => {
      const ws = insertWorkstream(ctx, task.id, { batchId: null });
      for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
        transitionWorkstream(ctx, ws.id, { to, fence: null });
      return ws.id;
    });
    const card = failedCard(project.id, workstreamId);

    const res = await startTask(task.id, {});

    expect(res.status).toBe(201);
    const started = WorkstreamDto.parse(res.body);
    expect(started.id).not.toBe(workstreamId);
    expect(cardState(card)).not.toBe('OPEN');
    await api().post(`/workstreams/${started.id}/cancel`, WorkstreamDto);
  });

  it('refuses a fresh start the starter would refuse and leaves the batch open, so Retry still works', async () => {
    // Alpha now waits on Beta, which has not finished (it was reopened, say): a new start is refused.
    const { project, task, batchId, workstreamId } = await failedInOpenBatch(['Beta']);

    const res = await startTask(task.id, { fresh: true });

    expect(res.status).toBe(409);
    const batches = await batchesOf(project.id);
    expect(batches.map((b) => [b.id, b.state])).toEqual([[batchId, 'OPEN']]);
    const runs = await api().get('/workstreams?active=false', z.array(WorkstreamDto));
    expect(runs.find((w) => w.id === workstreamId)?.state).toBe('FAILED');
  });
});
