import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GoalAdoptError,
  GoalAdoptPreview,
  GoalDto,
  ProjectDto,
  TaskDto,
  type ProjectId,
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
  data = tempDir('goal adopt');
  repo = createTempRepo();
  daemon = await startDaemon({
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

// An unknown depends_on key, a cycle and an unknown area, all at once.
const BAD = `---
title: Broken
objective: Three things wrong.
tasks:
  - key: a
    title: A
    areas: [repo]
    depends_on: [drawer-editr]
  - key: b
    title: B
    areas: [billing]
    depends_on: [c]
  - key: c
    title: C
    areas: [repo]
    depends_on: [b]
---
`;

const adopt = (projectId: ProjectId, body: unknown) =>
  post(`/projects/${projectId}/goals/adopt`, body);
const tasksOf = (projectId: ProjectId) =>
  api().get(`/projects/${projectId}/tasks`, z.array(TaskDto));
const goalsOf = (projectId: ProjectId) =>
  api().get(`/projects/${projectId}/goals`, z.array(GoalDto));

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

  it('refuses an unknown depends_on key, a cycle and an unknown area together, and writes nothing', async () => {
    const project = await seed();
    const res = await adopt(project.id, { text: BAD });
    expect(res.status).toBe(400);
    const { errors } = GoalAdoptError.parse(res.body);
    expect(errors).toEqual([
      { path: 'Task 1, depends on', message: 'no task has the key drawer-editr' },
      { path: 'Task 2, depends on', message: 'these tasks wait on each other: b, c, b' },
      {
        path: 'Task 2, areas',
        message: 'the project has no area billing (it has repo, docs)',
      },
    ]);
    expect(await tasksOf(project.id)).toEqual([]);
    expect(await goalsOf(project.id)).toEqual([]);
  });

  it('answers a dry run with what would be written, and writes nothing', async () => {
    const project = await seed();
    const res = await adopt(project.id, { text: GOOD, dryRun: true });
    expect(res.status).toBe(200);
    expect(GoalAdoptPreview.parse(res.body)).toEqual({
      dryRun: true,
      title: 'Real areas',
      taskKeys: ['task-patch-route', 'drawer-editor', 'propose-project-areas'],
      criteria: 2,
    });
    expect(await tasksOf(project.id)).toEqual([]);
    expect(await goalsOf(project.id)).toEqual([]);
  });

  it('answers a dry run of a broken brief with the same errors as adopting it', async () => {
    const project = await seed();
    const real = await adopt(project.id, { text: BAD });
    const dry = await adopt(project.id, { text: BAD, dryRun: true });
    expect(dry.status).toBe(400);
    expect(dry.body).toEqual(real.body);
    expect(await goalsOf(project.id)).toEqual([]);
  });

  it('accepts the same brief as a path and as text', async () => {
    const project = await seed();
    const file = join(data.path, 'brief.md');
    writeFileSync(file, GOOD);
    const fromText = GoalDto.parse((await adopt(project.id, { text: GOOD })).body);
    const res = await adopt(project.id, { path: file });
    expect(res.status).toBe(201);
    const fromPath = GoalDto.parse(res.body);
    const shape = (g: GoalDto) => ({
      title: g.title,
      objective: g.objective,
      description: g.description,
      criteria: g.criteria.map((c) => ({ text: c.text, check: c.check })),
      tasks: g.taskIds.length,
    });
    expect(shape(fromPath)).toEqual(shape(fromText));
    expect(fromPath.id).not.toBe(fromText.id);
  });

  it('refuses a path it cannot read, naming it', async () => {
    const project = await seed();
    const missing = join(data.path, 'nope.md');
    const res = await adopt(project.id, { path: missing });
    expect(res.status).toBe(400);
    expect(GoalAdoptError.parse(res.body).errors).toEqual([
      { path: 'File', message: `Can't read ${missing}: it does not exist` },
    ]);
  });

  it('refuses a relative path', async () => {
    const project = await seed();
    const res = await adopt(project.id, { path: 'brief.md' });
    expect(res.status).toBe(400);
    expect(GoalAdoptError.parse(res.body).errors[0]?.message).toContain('absolute');
  });

  it('refuses a body with both or neither of path and text', async () => {
    const project = await seed();
    expect((await adopt(project.id, { path: '/x.md', text: GOOD })).status).toBe(400);
    expect((await adopt(project.id, {})).status).toBe(400);
  });

  it('answers 404 for a project it does not have', async () => {
    await seed();
    const res = await post('/projects/prj_00000000-0000-7000-8000-000000000000/goals/adopt', {
      text: GOOD,
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /goals/:goalId and /projects/:projectId/goals', () => {
  it('lists a project’s goals oldest first and answers 404 for an unknown goal', async () => {
    const project = await seed();
    const first = GoalDto.parse((await adopt(project.id, { text: GOOD })).body);
    const second = GoalDto.parse(
      (await adopt(project.id, { text: GOOD.replace('Real areas', 'Second') })).body,
    );
    expect((await goalsOf(project.id)).map((g) => g.id)).toEqual([first.id, second.id]);
    const res = await fetch(`${daemon.url}/goals/gol_00000000-0000-7000-8000-000000000000`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(res.status).toBe(404);
  });
});
