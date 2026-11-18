import {
  BatchDto,
  ProjectDto,
  TaskDto,
  WorkstreamDto,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { insertBatch, transitionBatch, transitionWorkstream, insertWorkstream } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir, waitForAsync } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let worktrees: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('restart failed');
  worktrees = tempDir('restart failed worktrees');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    worktreeRoot: worktrees.path,
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
  worktrees.cleanup();
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

/** A pull-request project with one task, Alpha, whose run FAILED in an OPEN batch of its own. */
async function failedInOpenBatch() {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
  });
  const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'Alpha',
    acceptanceCriteria: ['x'],
    areas: ['src'],
    dependsOn: [],
  });
  const { batchId, workstreamId } = daemon.state.write((ctx) => {
    const batch = insertBatch(ctx, { projectId: project.id, title: 'Alpha', baseBranch: 'main' });
    transitionBatch(ctx, batch.id, { to: 'OPEN', patch: { branch: 'tendb/alpha' } });
    const ws = insertWorkstream(ctx, task.id, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      batchId: batch.id,
    });
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
});
