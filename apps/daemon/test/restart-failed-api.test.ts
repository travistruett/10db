import {
  BatchDto,
  DaemonEvent,
  ProjectDto,
  TaskDto,
  WorkstreamDto,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import {
  acquireClaims,
  activeClaims,
  claimConflict,
  claimRequestsForTask,
  getProject,
  insertBatch,
  insertWorkstream,
  patchWorkstream,
  transitionBatch,
  transitionWorkstream,
} from '@10db/db';
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

describe('POST /tasks/:id/start on a task whose failed lane run kept its claims', () => {
  // Value: protects=a new start of a task frees the claims its failed lane run kept, so the new run
  // and the tasks sharing its areas can start; fails_when=the replaced run keeps its claims for good,
  // and every run in its areas waits on a run that has finished; why_new=claims (core);
  // no_claim=what the new run makes of the files the failed run left in Your folder.
  it('lets the failed run go, so the new run and its area can start', async () => {
    const project = await api().post('/projects', ProjectDto, {
      name: 'lanes',
      repoPath: repo.path,
      gateCommand: 'true',
      areas: [{ name: 'src', globs: ['src/**'] }],
      delivery: 'local',
    });
    const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['x'],
      areas: ['src'],
      dependsOn: [],
    });
    // A lane run whose take-out could not move its files (Your folder is not on its base), so it
    // keeps its claims.
    const failed = daemon.state.write((ctx) => {
      const ws = insertWorkstream(ctx, task.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      patchWorkstream(ctx, ws.id, null, {
        branch: 'elsewhere',
        laneBranch: `10db/lane/${ws.id.slice(-8)}`,
      });
      const claimed = acquireClaims(ctx, {
        projectId: project.id,
        workstreamId: ws.id,
        requests: claimRequestsForTask(task, getProject(ctx.tx, project.id)),
        leaseExpiresAt: '2999-01-01T00:00:00.000Z',
      });
      if (!claimed.ok) throw new Error('the failed run could not claim its area');
      for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
        transitionWorkstream(ctx, ws.id, { to, fence: null });
      return ws.id;
    });
    // Its take-out has run and left the files where they are.
    await waitForAsync(async () => {
      const events = await api().get('/events?after=0&limit=1000', z.array(DaemonEvent));
      return events.find(
        (e) => e.type === 'notice.posted' && e.data['key'] === `lane-take-out:${task.id}`,
      );
    }, 10_000);
    expect(activeClaims(daemon.state.db, failed)).toHaveLength(1);

    const res = await startTask(task.id, {});

    expect(res.status).toBe(201);
    const started = WorkstreamDto.parse(res.body);
    expect(started.id).not.toBe(failed);
    expect(activeClaims(daemon.state.db, failed)).toEqual([]);
    expect(
      claimConflict(daemon.state.db, {
        projectId: project.id,
        workstreamId: started.id,
        requests: claimRequestsForTask(task, project),
      }),
    ).toBeNull();
    // The scheduler may launch the new run; cancel it so no lane outlives the daemon.
    await fetch(`${daemon.url}/workstreams/${started.id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
  });
});
