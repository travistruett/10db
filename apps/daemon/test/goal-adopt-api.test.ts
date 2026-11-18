import { GoalDto, GoalListDto, ProjectDto, TaskDto, type ProjectId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('goal adopt');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    // A tick long enough that nothing starts while the test looks.
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

async function post(path: string, body: unknown) {
  const res = await fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

async function seed() {
  return await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [
      { name: 'repo', globs: ['**'] },
      { name: 'docs', globs: ['docs/**'] },
    ],
  });
}

const GOOD = `---
title: Real areas
objective: 10db proposes a project's areas from its repository.
cares_most: Areas a non-engineer can read.
criteria:
  - text: A new project gets proposed areas
    check: task
    task: propose-project-areas
  - text: The builder accepts the area names
    check: accept
tasks:
  - key: task-patch-route
    title: Patch a task's areas and dependencies
    areas: [repo]
    criteria: [PATCH /tasks/:id changes areas]
  - key: drawer-editor
    title: Edit areas in the task drawer
    areas: [repo, docs]
    depends_on: [task-patch-route]
  - key: propose-project-areas
    title: Propose a new project's areas
    areas: [repo]
---

Notes below the front matter.
`;

const adopt = (projectId: ProjectId, body: unknown) =>
  post(`/projects/${projectId}/goals/adopt`, body);
const tasksOf = (projectId: ProjectId) =>
  api().get(`/projects/${projectId}/tasks`, z.array(TaskDto));
const goalsOf = async (projectId: ProjectId) =>
  (await api().get(`/projects/${projectId}/goals`, GoalListDto)).goals.map((s) => s.goal);

describe('POST /projects/:projectId/goals/adopt', () => {
  it('creates the goal in draft with its tasks on the Board and their dependencies', async () => {
    const project = await seed();
    const res = await adopt(project.id, { text: GOOD });
    expect(res.status).toBe(201);
    const goal = GoalDto.parse(res.body);
    expect(goal).toMatchObject({
      projectId: project.id,
      title: 'Real areas',
      state: 'draft',
      caresMost: 'Areas a non-engineer can read.',
      description: 'Notes below the front matter.',
    });
    expect(goal.criteria.map((c) => c.state)).toEqual(['unproven', 'unproven']);

    const tasks = await tasksOf(project.id);
    expect(tasks.map((t) => t.title)).toEqual([
      "Patch a task's areas and dependencies",
      'Edit areas in the task drawer',
      "Propose a new project's areas",
    ]);
    expect(tasks.every((t) => t.goalId === goal.id)).toBe(true);
    const [patchRoute, drawer] = tasks;
    expect(drawer?.dependsOn).toEqual([patchRoute?.id]);
    expect(new Set(goal.taskIds)).toEqual(new Set(tasks.map((t) => t.id)));
    expect(goal.criteria[0]?.taskId).toBe(tasks[2]?.id);

    expect(await api().get(`/goals/${goal.id}`, GoalDto)).toEqual(goal);
    expect(await goalsOf(project.id)).toEqual([goal]);
  });

  it("runs the placement rule on the tasks it makes: an area in the project's isolate list gets a copy and a reason", async () => {
    const project = await api().post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      areas: [
        { name: 'repo', globs: ['**'] },
        { name: 'docs', globs: ['docs/**'] },
      ],
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
      isolate: ['docs'],
    });
    const res = await adopt(project.id, { text: GOOD });
    expect(res.status).toBe(201);
    const placed = (await tasksOf(project.id)).map((t) => ({
      title: t.title,
      workspaceMode: t.workspaceMode,
      placementReason: t.placementReason,
    }));
    expect(placed).toEqual([
      {
        title: "Patch a task's areas and dependencies",
        workspaceMode: 'shared',
        placementReason: null,
      },
      {
        title: 'Edit areas in the task drawer',
        workspaceMode: 'worktree',
        placementReason: 'touches docs',
      },
      { title: "Propose a new project's areas", workspaceMode: 'shared', placementReason: null },
    ]);
  });
});
