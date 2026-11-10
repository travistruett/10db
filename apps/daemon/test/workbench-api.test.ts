import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GoalPassPagesDto,
  mintId,
  PagesProposalDto,
  PassAbandonedDto,
  PassDto,
  PassOpenedDto,
  PassStartDto,
  PassTurnWithFilesDto,
  PassViewDto,
  ProjectDto,
  TakeOutResultDto,
  TaskDto,
  TaskMessageDto,
  TurnActivityDto,
  type ProjectInput,
} from '@10db/contracts';
import {
  endPassTurn,
  getTask,
  insertGoal,
  insertPassTurn,
  insertSession,
  insertWorkstream,
  listTaskThread,
  schema,
  setTaskKeptWork,
  settlePassTurn,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { createTempRepo, isolatedGitEnv, tempDir, waitForAsync } from './fixtures';
import { pngImage } from './png';

// Workbench spec §4.2, §4.3, §5: the routes the Workbench reads and acts through, over HTTP on a real
// repository and database. A page that starts takes its message and waits for one never sent.

/** A page's session: it takes the message it was started for, then waits. */
const WAITS = [[{ do: 'consume' }, { do: 'await_message', contains: 'never sent' }]] as const;

const PAGES: ProjectInput['areas'] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  { name: 'src', globs: ['src/**'], role: 'shared' },
];

/**
 * The Milestone 1 loop's pages: Billing ends each turn Ready, the second after the builder's message;
 * Home keeps working until it is stopped.
 */
const LOOP_SCRIPTS: FakeScriptBook = {
  'Billing: UI work': [
    [
      { do: 'consume' },
      {
        do: 'tool',
        toolName: 'Write',
        input: { file_path: 'src/billing/page.tsx', content: 'a\n' },
      },
      { do: 'turn_complete', text: 'Tidied the form.' },
      { do: 'await_message', contains: 'padding too tight' },
      { do: 'consume' },
      {
        do: 'tool',
        toolName: 'Write',
        input: { file_path: 'src/billing/page.tsx', content: 'b\n' },
      },
      { do: 'turn_complete', text: 'Loosened the padding.' },
      { do: 'await_message', contains: 'never sent' },
    ],
  ],
  'Home: UI work': [
    [
      { do: 'consume' },
      {
        do: 'tool',
        toolName: 'Write',
        input: { file_path: 'src/home/page.tsx', content: 'half\n' },
      },
      { do: 'await_message', contains: 'never sent' },
    ],
  ],
};

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
      ...LOOP_SCRIPTS,
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
    /** What Start Pass's preview says first, for a refusal that is the folder's, not the request's. */
    preview?: string;
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
      preview: 'return_branch',
      arrange: () => {
        rawGit('switch', '-q', '-c', '10db/stray-abc123');
        return { pages: ['settings', 'people'] };
      },
    },
  ])(
    'refuses $name with $status, leaving no task and no pass',
    async ({ arrange, status, preview }) => {
      const project = await projectWith(PAGES);
      const head = rawGit('symbolic-ref', '--short', 'HEAD');
      const extra = await arrange(project);
      const branch = rawGit('symbolic-ref', '--short', 'HEAD');
      const start = await api().get(`/projects/${project.id}/pass-start`, PassStartDto);
      expect(start.refusal?.code ?? null).toBe(preview ?? null);

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
    },
  );
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

describe('PATCH /passes/:passId', () => {
  it('renames the pass, and refuses an empty name and an abandoned pass', async () => {
    const project = await projectWith(PAGES);
    const opened = await openOn(project, [await taskOn(project, 'Settings: tidy', ['settings'])]);

    const renamed = await api().patch(`/passes/${opened.pass.id}`, PassDto, {
      name: 'Settings, tidied',
    });

    expect(renamed).toMatchObject({ id: opened.pass.id, name: 'Settings, tidied' });
    expect((await send('PATCH', `/passes/${opened.pass.id}`, { name: '' })).status).toBe(400);
    await api().post(`/passes/${opened.pass.id}/abandon`, PassAbandonedDto);
    expect((await send('PATCH', `/passes/${opened.pass.id}`, { name: 'Later' })).status).toBe(409);
  });
});

/** Work kept for the task at its kept ref, as a take-out leaves it: a commit off HEAD no branch names. */
function keepWorkFor(taskId: TaskDto['id']): string {
  const head = rawGit('rev-parse', 'HEAD');
  const tree = rawGit('rev-parse', 'HEAD^{tree}');
  const sha = rawGit('commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', 'kept');
  rawGit('update-ref', `refs/10db/kept/${taskId}`, sha);
  daemon.state.write((ctx) => {
    setTaskKeptWork(ctx, taskId, { keptSha: sha, keptBaseSha: head });
  });
  return sha;
}

describe('DELETE /tasks/:taskId/kept-work', () => {
  it("discards the task's saved work: its kept ref is gone and the task no longer has any", async () => {
    const project = await projectWith(PAGES);
    const task = await taskOn(project, 'Settings: tidy', ['settings']);
    keepWorkFor(task.id);

    const res = await send('DELETE', `/tasks/${task.id}/kept-work`);

    expect(res.status).toBe(204);
    expect(rawGit('for-each-ref', '--format=%(refname)', 'refs/10db/kept/')).toBe('');
    const tasks = await api().get(`/projects/${project.id}/tasks`, z.array(TaskDto));
    expect(tasks.find((t) => t.id === task.id)?.keptWork).toBe(false);
  });

  it('refuses with 409 while a pass holds the task, and leaves its saved work', async () => {
    const project = await projectWith(PAGES);
    const task = await taskOn(project, 'Settings: tidy', ['settings']);
    await openOn(project, [task]);
    const sha = keepWorkFor(task.id);

    expect((await send('DELETE', `/tasks/${task.id}/kept-work`)).status).toBe(409);
    expect(rawGit('rev-parse', `refs/10db/kept/${task.id}`)).toBe(sha);
  });
});

/** Commits each file, with its path as its content, in the test's repository. */
function commitFiles(paths: readonly string[]): void {
  for (const path of paths) {
    const file = join(repo.path, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${path}\n`);
  }
  rawGit('add', ...paths);
  rawGit('commit', '-q', '--no-gpg-sign', '-m', 'An app');
}

describe('POST /projects/:projectId/propose-page-areas', () => {
  it('proposes the screens the project has no page for, and says why it left out the one it has', async () => {
    commitFiles([
      'package.json',
      'app/layout.tsx',
      'app/(marketing)/page.tsx',
      'app/settings/page.tsx',
      'app/people/page.tsx',
      'app/billing/page.tsx',
    ]);
    const project = await projectWith([
      { name: 'settings', globs: ['app/settings/**'], role: 'page', route: '/settings' },
      { name: 'repo', globs: ['**'], catchAll: true },
    ]);

    const proposal = await api().post(
      `/projects/${project.id}/propose-page-areas`,
      PagesProposalDto,
    );

    expect(proposal.pages.map((p) => [p.globs, p.role, p.route ?? null])).toEqual([
      [['app/(marketing)/**'], 'page', null],
      [['app/billing/**'], 'page', '/billing'],
      [['app/people/**'], 'page', '/people'],
    ]);
    expect(proposal.skipped.map((s) => s.name)).toEqual(['settings']);
  });
});

describe('GET /goals/:goalId/pass-pages', () => {
  it("answers the pages a goal's tasks committed in, and 404 for a goal there is none of", async () => {
    const project = await projectWith(PAGES);
    const goal = goalOf(project);

    expect(await api().get(`/goals/${goal.id}/pass-pages`, GoalPassPagesDto)).toEqual({
      pages: [],
      fromTasks: [],
    });
    expect((await send('GET', `/goals/${mintId('Goal')}/pass-pages`)).status).toBe(404);
  });
});

/** A page of an open pass whose first turn ended Ready, with one activity row from its session. */
async function readyTurn() {
  const project = await projectWith(PAGES);
  const settings = await taskOn(project, 'Settings: tidy', ['settings']);
  const people = await taskOn(project, 'People: tidy', ['people']);
  const opened = await openOn(project, [settings, people]);
  const turn = daemon.state.write((ctx) => {
    const workstreamId = getTask(ctx.tx, settings.id).workstreamId;
    if (workstreamId === null) throw new Error('the page has a run');
    const session = insertSession(ctx, {
      workstreamId,
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: 'workbench-api',
    });
    const started = insertPassTurn(ctx, {
      taskId: settings.id,
      workstreamId,
      sessionId: session.id,
      messageId: null,
    });
    ctx.emit({
      type: 'session.activity',
      entityType: 'session',
      entityId: session.id,
      data: {
        workstreamId,
        kind: 'tool',
        summary: 'Edit src/settings/page.tsx',
        tool: { name: 'Edit', target: 'src/settings/page.tsx' },
        turn: { id: started.id, filesTouched: ['src/settings/page.tsx'] },
      },
    });
    endPassTurn(ctx, started.id, { ending: 'ready', replyBody: 'Tidied it.' });
    return settlePassTurn(ctx, started.id);
  });
  return { settings, people, pass: opened.pass, turn };
}

describe("a page's turns over HTTP", () => {
  it("lists the task's turns with their files, and the turn's log", async () => {
    const { settings, turn } = await readyTurn();

    const turns = await api().get(`/tasks/${settings.id}/turns`, z.array(PassTurnWithFilesDto));
    const log = await api().get(`/pass-turns/${turn.id}/activity`, z.array(TurnActivityDto));

    expect(turns.map((t) => [t.id, t.seq, t.files])).toEqual([[turn.id, 1, []]]);
    expect(log.map((l) => [l.kind, l.summary])).toEqual([['tool', 'Edit src/settings/page.tsx']]);
  });

  it("notes the Ready page opened once, and refuses another task's turn", async () => {
    const { settings, people, pass, turn } = await readyTurn();

    const first = await send('POST', `/tasks/${settings.id}/turns/${turn.id}/opened`);
    const openedAt = (await api().get(`/passes/${pass.id}`, PassViewDto)).turns[0]?.openedAt;
    const again = await send('POST', `/tasks/${settings.id}/turns/${turn.id}/opened`);

    expect([first.status, again.status]).toEqual([204, 204]);
    expect(openedAt).not.toBeNull();
    expect((await api().get(`/passes/${pass.id}`, PassViewDto)).turns[0]?.openedAt).toBe(openedAt);
    expect((await send('POST', `/tasks/${people.id}/turns/${turn.id}/opened`)).status).toBe(409);
  });
});

describe('the Milestone 1 loop over HTTP, as the desktop sends it', () => {
  it('opens a pass on two pages, takes a message with a picture to Ready, stops one, takes one out and abandons', async () => {
    const project = await projectWith([
      { name: 'billing', globs: ['src/billing/**'], role: 'page', route: '/billing' },
      { name: 'home', globs: ['src/home/**'], role: 'page', route: '/' },
      { name: 'src', globs: ['src/**'], role: 'shared' },
    ]);
    const start = await api().get(`/projects/${project.id}/pass-start`, PassStartDto);
    expect([start.refusal, start.pages.map((p) => p.area)]).toEqual([null, ['billing', 'home']]);

    const opened = await api().post(`/projects/${project.id}/passes`, PassOpenedDto, {
      name: 'Billing and Home pass',
      taskIds: [],
      pages: ['billing', 'home'],
      firstMessage: 'These feel cramped',
    });
    const passId = opened.pass.id;
    const live = () => api().get('/passes?live=true', z.array(PassViewDto));
    const page = async (area: string) => {
      const found = (await live())
        .find((view) => view.pass.id === passId)
        ?.pages.find((p) => p.area === area);
      if (found === undefined) throw new Error(`the pass has no ${area} page`);
      return found;
    };
    const readyTurn = (area: string, seq: number) =>
      waitForAsync(async () => {
        const turn = (await page(area)).turn;
        return turn?.seq === seq && turn.readyAt !== null ? turn : undefined;
      });

    const first = await readyTurn('billing', 1);
    const billing = (await page('billing')).taskId;
    expect((await send('POST', `/tasks/${billing}/turns/${first.id}/opened`)).status).toBe(204);

    // The composer's Send: the words and a picture in one multipart message.
    const form = new FormData();
    form.set('text', 'padding too tight');
    form.append(
      'picture',
      new Blob([new Uint8Array(pngImage(1, 1))], { type: 'image/png' }),
      'cramped.png',
    );
    const sent = await fetch(`${daemon.url}/tasks/${billing}/thread`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}` },
      body: form,
    });
    expect(sent.status).toBe(201);
    expect(TaskMessageDto.parse(await sent.json()).files).toHaveLength(1);
    const second = await readyTurn('billing', 2);
    const turns = await api().get(`/tasks/${billing}/turns`, z.array(PassTurnWithFilesDto));
    expect(turns.map((t) => [t.seq, t.files.map((f) => f.path)])).toEqual([
      [1, ['src/billing/page.tsx']],
      [2, ['src/billing/page.tsx']],
    ]);
    const log = await api().get(`/pass-turns/${second.id}/activity`, z.array(TurnActivityDto));
    expect(log.length).toBeGreaterThan(0);

    // An empty composer's Stop on the page still working.
    const home = await waitForAsync(async () => {
      const found = await page('home');
      return found.turn?.activity?.filesTouched.includes('src/home/page.tsx') ? found : undefined;
    });
    expect((await send('POST', `/tasks/${home.taskId}/stop`)).status).toBe(204);
    expect((await page('home')).turn?.endedAt).not.toBeNull();

    // Take Out… keeps every shared change.
    const takeOut = await send('POST', `/passes/${passId}/tasks/${billing}/take-out`, {
      shared: [],
    });
    expect(takeOut.status).toBe(200);
    expect(TakeOutResultDto.parse(takeOut.body).tookOut).toBe(true);
    expect((await live())[0]?.pages.map((p) => p.area)).toEqual(['home']);

    const abandoned = await send('POST', `/passes/${passId}/abandon`);
    expect(abandoned.status).toBe(200);
    PassAbandonedDto.parse(abandoned.body);
    expect(await live()).toEqual([]);
  });
});
