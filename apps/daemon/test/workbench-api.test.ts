import { execFileSync } from 'node:child_process';
import {
  PassAbandonedDto,
  PassOpenedDto,
  PassStartDto,
  PassViewDto,
  ProjectDto,
  TaskDto,
  type ProjectInput,
} from '@10db/contracts';
import {
  insertGoal,
  insertWorkstream,
  listTaskThread,
  schema,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { createTempRepo, isolatedGitEnv, tempDir } from './fixtures';

// Workbench spec §4.2, §4.3, §5: the routes the Workbench reads and acts through, over HTTP on a real
// repository and database. A page that starts takes its message and waits for one never sent.

/** A page's session: it takes the message it was started for, then waits. */
const WAITS = [[{ do: 'consume' }, { do: 'await_message', contains: 'never sent' }]] as const;

const PAGES: ProjectInput['areas'] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  { name: 'src', globs: ['src/**'], role: 'shared' },
];

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
/** Other repositories a test made, removed after it. */
const repos: { cleanup(): void }[] = [];
beforeEach(async () => {
  data = tempDir('workbench api');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({
      'Settings: UI work': WAITS.map((s) => [...s]),
      'People: UI work': WAITS.map((s) => [...s]),
    }),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    // A tick long enough that nothing starts while the test looks.
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  for (const other of repos.splice(0)) other.cleanup();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);
const rawGit = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], {
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();

/** A request with a JSON body, answered with its status and parsed body whatever the status. */
async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: jsonOrText(await res.text()) };
}

/** A response body as JSON, or its text when it is not JSON (hono's own 404). */
function jsonOrText(text: string): unknown {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return text;
  }
}

async function projectWith(areas: ProjectInput['areas'], name = 'demo', repoPath = repo.path) {
  return api().post('/projects', ProjectDto, { name, repoPath, gateCommand: null, areas });
}

async function taskOn(project: ProjectDto, title: string, areas: string[]) {
  return api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title,
    acceptanceCriteria: ['x'],
    areas,
    dependsOn: [],
  });
}

async function openOn(project: ProjectDto, tasks: readonly TaskDto[]) {
  return api().post(`/projects/${project.id}/passes`, PassOpenedDto, {
    name: 'Polish',
    taskIds: tasks.map((t) => t.id),
  });
}

describe('GET /passes?live=true', () => {
  it('answers each live pass as the Workbench reads it, and none once it is abandoned', async () => {
    const project = await projectWith(PAGES);
    const settings = await taskOn(project, 'Settings: tidy', ['settings']);
    const opened = await openOn(project, [settings]);

    const live = await api().get('/passes?live=true', z.array(PassViewDto));
    expect(live.map((v) => [v.pass.id, v.pages.map((p) => p.taskId)])).toEqual([
      [opened.pass.id, [settings.id]],
    ]);

    await api().post(`/passes/${opened.pass.id}/abandon`, PassAbandonedDto);
    expect(await api().get('/passes?live=true', z.array(PassViewDto))).toEqual([]);
    expect(rawGit('symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('refuses a list of passes that is not the live one', async () => {
    expect((await send('GET', '/passes')).status).toBe(400);
  });
});

describe('GET /projects/:projectId/pass-start', () => {
  it('says what Start Pass shows: the pages, and that the gate needs Docker, which is off', async () => {
    const project = await api().post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'docker compose run --rm test',
      areas: PAGES,
    });

    const start = await api().get(`/projects/${project.id}/pass-start`, PassStartDto);

    expect(start.pages.map((p) => [p.area, p.route])).toEqual([
      ['settings', '/settings'],
      ['people', '/people'],
    ]);
    expect(start.lacks.map((l) => l.kind)).toContain('docker_off');
    expect(start.refusal).toBeNull();
  });
});

/** The builder messages of the task's thread, oldest first. */
const builderMessages = (taskId: TaskDto['id']) =>
  listTaskThread(daemon.state.db, taskId)
    .filter((m) => m.author === 'builder')
    .map((m) => m.body);

/** A draft goal of the project with one task, whose id Work on This sends. */
function goalOf(project: ProjectDto) {
  return daemon.state.write(
    (ctx) =>
      insertGoal(ctx, project.id, {
        brief: {
          title: 'Settings rework',
          objective: 'Rework the settings.',
          tasks: [{ key: 'a', title: 'Rework the settings', areas: ['settings'] }],
        },
      }).goal,
  );
}

const uiTasks = (project: ProjectDto) =>
  daemon.state.db
    .select()
    .from(schema.tasks)
    .all()
    .filter((t) => t.projectId === project.id && t.title.endsWith(': UI work'));

describe('POST /projects/:projectId/passes with pages', () => {
  it('makes a task with no brief for each page, linked to the goal, in the pass, and sends none a message', async () => {
    const project = await projectWith(PAGES);
    const goal = goalOf(project);

    const opened = await api().post(`/projects/${project.id}/passes`, PassOpenedDto, {
      name: 'Settings and people',
      taskIds: [],
      pages: ['settings', 'people'],
      goalId: goal.id,
    });

    const view = await api().get(`/passes/${opened.pass.id}`, PassViewDto);
    expect(view.pages.map((p) => [p.title, p.area])).toEqual([
      ['Settings: UI work', 'settings'],
      ['People: UI work', 'people'],
    ]);
    const made = await api().get(`/projects/${project.id}/tasks`, z.array(TaskDto));
    for (const page of view.pages) {
      const task = made.find((t) => t.id === page.taskId);
      expect(task).toMatchObject({
        description: '',
        acceptanceCriteria: [],
        areas: [page.area],
        goalId: goal.id,
        passId: opened.pass.id,
        workspaceMode: 'shared',
      });
      expect(builderMessages(page.taskId)).toEqual([]);
    }
    expect(rawGit('symbolic-ref', '--short', 'HEAD')).toBe(opened.batch.branch);
  });

  it("sends the builder's first message to each new page, beside a task that joins", async () => {
    const project = await projectWith(PAGES);
    const people = await taskOn(project, 'People: tidy', ['people']);

    const opened = await api().post(`/projects/${project.id}/passes`, PassOpenedDto, {
      name: 'Polish',
      taskIds: [people.id],
      pages: ['settings'],
      firstMessage: 'These feel cramped',
    });

    const view = await api().get(`/passes/${opened.pass.id}`, PassViewDto);
    expect(view.pages.map((p) => [p.title, builderMessages(p.taskId)])).toEqual([
      ['People: tidy', ['These feel cramped']],
      ['Settings: UI work', ['These feel cramped']],
    ]);
  });

  it.each<{
    name: string;
    status: number;
    arrange: (project: ProjectDto) => Promise<Record<string, unknown>> | Record<string, unknown>;
  }>([
    { name: 'an area that is not a page', status: 400, arrange: () => ({ pages: ['src'] }) },
    { name: 'an unknown page', status: 400, arrange: () => ({ pages: ['billing'] }) },
    {
      name: 'more pages than the pass holds',
      status: 400,
      arrange: () => ({ pages: ['settings', 'people'], pageCap: 1 }),
    },
    {
      name: 'a page named twice',
      status: 400,
      arrange: () => ({ pages: ['settings', 'settings'] }),
    },
    {
      name: 'a page a joining task holds',
      status: 400,
      arrange: async (project) => ({
        taskIds: [(await taskOn(project, 'Settings: tidy', ['settings'])).id],
        pages: ['settings'],
      }),
    },
    {
      name: "another project's goal",
      status: 400,
      arrange: async () => {
        const other = createTempRepo();
        repos.push(other);
        const elsewhere = await projectWith(PAGES, 'other', other.path);
        return { pages: ['settings'], goalId: goalOf(elsewhere).id };
      },
    },
    {
      name: 'a folder on a 10db branch no task names, refused in the write',
      status: 409,
      arrange: () => {
        rawGit('switch', '-q', '-c', '10db/stray-abc123');
        return { pages: ['settings', 'people'] };
      },
    },
  ])('refuses $name with $status, leaving no task and no pass', async ({ arrange, status }) => {
    const project = await projectWith(PAGES);
    const head = rawGit('symbolic-ref', '--short', 'HEAD');
    const extra = await arrange(project);
    const branch = rawGit('symbolic-ref', '--short', 'HEAD');

    const res = await send('POST', `/projects/${project.id}/passes`, {
      name: 'Polish',
      taskIds: [],
      ...extra,
    });

    expect(res.status).toBe(status);
    expect(uiTasks(project)).toEqual([]);
    expect(daemon.state.db.select().from(schema.passes).all()).toEqual([]);
    expect(rawGit('symbolic-ref', '--short', 'HEAD')).toBe(branch);
    expect(head).toBe('main');
  });
});

describe('POST /passes/:passId/pages', () => {
  it('adds a page and an open task to the pass, and answers the pass as the Workbench reads it', async () => {
    const project = await projectWith(PAGES);
    const settings = await taskOn(project, 'Settings: tidy', ['settings']);
    const opened = await openOn(project, [settings]);
    const people = await taskOn(project, 'People: tidy', ['people']);

    const view = await api().post(`/passes/${opened.pass.id}/pages`, PassViewDto, {
      pages: [],
      taskIds: [people.id],
      firstMessage: null,
    });

    expect(view.pages.map((p) => p.title)).toEqual(['Settings: tidy', 'People: tidy']);
    expect(builderMessages(people.id)).toEqual([]);
  });

  it.each<{
    name: string;
    status: number;
    arrange: (project: ProjectDto) => Promise<{ passId: string; body: Record<string, unknown> }>;
  }>([
    {
      name: 'a page the pass has',
      status: 400,
      arrange: async (project) => {
        const opened = await openOn(project, [
          await taskOn(project, 'Settings: tidy', ['settings']),
        ]);
        return { passId: opened.pass.id, body: { pages: ['settings'] } };
      },
    },
    {
      name: "a page past the pass's cap",
      status: 409,
      arrange: async (project) => {
        const opened = await api().post(`/projects/${project.id}/passes`, PassOpenedDto, {
          name: 'Polish',
          taskIds: [],
          pages: ['settings'],
          pageCap: 1,
        });
        return { passId: opened.pass.id, body: { pages: ['people'] } };
      },
    },
    {
      name: 'a pass that is abandoned',
      status: 409,
      arrange: async (project) => {
        const opened = await openOn(project, [
          await taskOn(project, 'Settings: tidy', ['settings']),
        ]);
        await api().post(`/passes/${opened.pass.id}/abandon`, PassAbandonedDto);
        return { passId: opened.pass.id, body: { pages: ['people'] } };
      },
    },
    {
      name: 'a task that is running',
      status: 409,
      arrange: async (project) => {
        const opened = await openOn(project, [
          await taskOn(project, 'Settings: tidy', ['settings']),
        ]);
        const people = await taskOn(project, 'People: tidy', ['people']);
        daemon.state.write((ctx) => {
          const ws = insertWorkstream(ctx, people.id, {
            first: { model: 'claude-sonnet-5-5', effort: 'medium' },
          });
          transitionWorkstream(ctx, ws.id, { to: 'STARTING', fence: null });
        });
        return { passId: opened.pass.id, body: { taskIds: [people.id] } };
      },
    },
  ])('refuses $name with $status, adding nothing', async ({ arrange, status }) => {
    const project = await projectWith(PAGES);
    const { passId, body } = await arrange(project);
    const before = daemon.state.db.select().from(schema.tasks).all();

    const res = await send('POST', `/passes/${passId}/pages`, {
      pages: [],
      taskIds: [],
      firstMessage: null,
      ...body,
    });

    expect(res.status).toBe(status);
    expect(daemon.state.db.select().from(schema.tasks).all()).toEqual(before);
  });
});
