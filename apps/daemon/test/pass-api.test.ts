import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountCreatedDto,
  mintId,
  PASS_SIGN_OFF_CHOICE,
  PassOpenedDto,
  PassViewDto,
  ProjectDto,
  TaskDto,
  WorkstreamChangesDto,
  WorkstreamDto,
  type PassCheckDetail,
  type ProjectInput,
} from '@10db/contracts';
import {
  endPassTurn,
  getInboxItem,
  insertBatch,
  getWorkstreamRow,
  insertInboxItem,
  insertPass,
  insertPassTurn,
  insertWorkstream,
  listEvidence,
  listTaskThread,
  patchWorkstream,
  schema,
  setPassTurnKept,
  settlePassTurn,
  transitionBatch,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, isolatedGitEnv, tempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

// Workbench spec §5.1, §6.1: a pass opens over HTTP with each page's first message written, so its
// first turn has one; a pass page is never approved or sent back, its Ready item answers only with
// Sign Off, and what the builder is shown is the turn's kept commit.

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('pass api');
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
const rawGit = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], {
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();

async function post(path: string, body: unknown) {
  const res = await fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

/** A commit of `path` off HEAD that no branch names, as a turn's kept commit is. */
function keptCommit(path: string, content: string): string {
  const file = join(repo.path, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
  rawGit('add', path);
  const tree = rawGit('write-tree');
  rawGit('rm', '-q', '--cached', path);
  return rawGit('commit-tree', '--no-gpg-sign', tree, '-p', 'HEAD', '-m', 'kept');
}

/**
 * A page of an open pass whose first turn has ended Ready: the workstream waits on its `check` item,
 * whose only option is Sign Off and whose detail names the turn's kept commit.
 */
async function readyPage() {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: null,
    areas: [{ name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' }],
  });
  const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'Settings: tidy the form',
    acceptanceCriteria: ['x'],
    areas: ['settings'],
    dependsOn: [],
  });
  const startSha = rawGit('rev-parse', 'HEAD');
  const keptSha = keptCommit('src/settings/page.tsx', 'tidied\n');
  return daemon.state.write((ctx) => {
    const { pass, batch } = insertPass(ctx, {
      id: mintId('Pass'),
      projectId: project.id,
      name: 'Polish',
      pageCap: 4,
      returnBranch: 'main',
      startSha,
      branch: '10db/polish-abcdef',
      baseBranch: 'main',
      repo: null,
      taskIds: [task.id],
      dirt: [],
    });
    const ws = insertWorkstream(ctx, task.id, {
      batchId: batch.id,
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    for (const to of ['STARTING', 'RUNNING'] as const)
      transitionWorkstream(ctx, ws.id, { to, fence: null });
    const turn = insertPassTurn(ctx, {
      taskId: task.id,
      workstreamId: ws.id,
      sessionId: null,
      messageId: null,
    });
    endPassTurn(ctx, turn.id, { ending: 'ready', replyBody: 'Tidied the form.' });
    setPassTurnKept(ctx, turn.id, { keptSha, keptBaseSha: startSha, sharedSeq: null });
    settlePassTurn(ctx, turn.id);
    const detail: PassCheckDetail = {
      passId: pass.id,
      taskId: task.id,
      workstreamId: ws.id,
      turnId: turn.id,
      keptSha,
      keptBaseSha: startSha,
      turnFiles: [{ path: 'src/settings/page.tsx', added: 1, removed: 0 }],
      pageFiles: [{ path: 'src/settings/page.tsx', added: 1, removed: 0 }],
    };
    const item = insertInboxItem(ctx, {
      projectId: project.id,
      kind: 'check',
      title: `Ready: ${task.title}`,
      body: 'The page is ready to look at.',
      options: [{ label: PASS_SIGN_OFF_CHOICE, description: 'The page is right' }],
      recommendation: null,
      category: 'product',
      urgency: 'normal',
      detail,
      foldKey: null,
      targets: [{ workstreamId: ws.id, sessionId: null }],
    });
    transitionWorkstream(ctx, ws.id, {
      to: 'WAITING_HUMAN',
      fence: null,
      patch: { nextAction: { kind: 'pass_review', inboxId: item.id } },
    });
    return { project, task, pass, ws, item, keptSha, startSha };
  });
}

describe('a Ready pass page', () => {
  it.each([
    { name: 'Approve', answer: { choice: 'approve' }, status: 400 },
    { name: 'Send Back', answer: { choice: 'send_back', note: 'Bigger' }, status: 400 },
    {
      name: 'Sign Off, until closing lands',
      answer: { choice: PASS_SIGN_OFF_CHOICE },
      status: 409,
    },
  ])('refuses $name and leaves the page as it was', async ({ answer, status }) => {
    const page = await readyPage();
    const before = getWorkstreamRow(daemon.state.db, page.ws.id);

    const res = await post(`/inbox/${page.item.id}/answer`, answer);

    expect(res.status).toBe(status);
    const after = getWorkstreamRow(daemon.state.db, page.ws.id);
    expect(after).toMatchObject({
      state: 'WAITING_HUMAN',
      attempt: before.attempt,
      nextAction: { kind: 'pass_review', inboxId: page.item.id },
    });
    expect(listEvidence(daemon.state.db, page.ws.id)).toEqual([]);
    expect(getInboxItem(daemon.state.db, page.item.id).state).toBe('OPEN');
  });

  it("an answer to the lane's earlier question leaves the page waiting for the builder's message", async () => {
    const page = await readyPage();
    const question = daemon.state.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: page.project.id,
        kind: 'question',
        title: 'Which label?',
        body: 'Which label should the button have?',
        options: [],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [{ workstreamId: page.ws.id, sessionId: null }],
      }),
    );

    const res = await post(`/inbox/${question.id}/answer`, { choice: 'Save' });

    expect(res.status).toBe(200);
    expect(getWorkstreamRow(daemon.state.db, page.ws.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      nextAction: { kind: 'pass_review', inboxId: page.item.id },
    });
  });

  it("shows the turn's kept commit against the pass branch tip it was kept on, with no commits", async () => {
    const page = await readyPage();
    daemon.state.write((ctx) => {
      patchWorkstream(ctx, page.ws.id, null, { baseHead: page.startSha });
    });
    // The folder moves on after the page was Ready; what is shown is still the kept commit.
    writeFileSync(join(repo.path, 'later.txt'), 'later\n');
    rawGit('add', 'later.txt');
    rawGit('commit', '-q', '-m', 'later');

    const changes = await api().get(`/workstreams/${page.ws.id}/changes`, WorkstreamChangesDto);

    expect(changes).toMatchObject({
      baseHead: page.startSha,
      head: page.keptSha,
      commits: [],
      files: [{ path: 'src/settings/page.tsx', added: 1, removed: 0 }],
    });
    expect(changes.diff).toContain('+tidied');
  });
});

const PAGES: ProjectInput['areas'] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  { name: 'src', globs: ['src/**'], role: 'shared' },
];

async function projectWith(areas: ProjectInput['areas']) {
  return api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: null,
    areas,
  });
}

async function taskOn(project: ProjectDto, title: string, areas: string[], description = '') {
  return api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title,
    description,
    acceptanceCriteria: ['x'],
    areas,
    dependsOn: [],
  });
}

/** The builder messages of the task's thread, oldest first. */
const firstMessages = (task: TaskDto) =>
  listTaskThread(daemon.state.db, task.id)
    .filter((m) => m.author === 'builder')
    .map((m) => m.body);

describe('POST /projects/:projectId/passes', () => {
  it("opens a pass on the folder with each page's first message, and the pass reads back", async () => {
    const project = await projectWith(PAGES);
    const settings = await taskOn(project, 'Settings: tidy', ['settings'], 'Tidy the form');
    const people = await taskOn(project, 'People: tidy', ['people']);

    const opened = await api().post(`/projects/${project.id}/passes`, PassOpenedDto, {
      name: 'Polish pages',
      taskIds: [settings.id, people.id],
    });

    expect(opened.pass).toMatchObject({ state: 'OPEN', returnBranch: 'main' });
    expect(rawGit('symbolic-ref', '--short', 'HEAD')).toBe(opened.batch.branch);
    // A task with a description starts from it; one without has nothing to start from.
    expect(firstMessages(settings)).toEqual(['Tidy the form']);
    expect(firstMessages(people)).toEqual([]);
    const view = await api().get(`/passes/${opened.pass.id}`, PassViewDto);
    expect(view.pass.id).toBe(opened.pass.id);
    expect(view.pages.map((p) => [p.taskId, p.area])).toEqual([
      [settings.id, 'settings'],
      [people.id, 'people'],
    ]);
  });

  it("sends the builder's first message to every page, over a task's description", async () => {
    const project = await projectWith(PAGES);
    const settings = await taskOn(project, 'Settings: tidy', ['settings'], 'Tidy the form');
    const people = await taskOn(project, 'People: tidy', ['people']);

    await api().post(`/projects/${project.id}/passes`, PassOpenedDto, {
      name: 'Polish pages',
      taskIds: [settings.id, people.id],
      firstMessage: 'Make the spacing even',
    });

    expect(firstMessages(settings)).toEqual(['Make the spacing even']);
    expect(firstMessages(people)).toEqual(['Make the spacing even']);
  });

  it.each<{
    name: string;
    status: number;
    arrange: () => Promise<{ project: ProjectDto; taskIds: string[]; pageCap?: number }>;
  }>([
    {
      name: 'a project with no page area',
      status: 409,
      arrange: async () => {
        const project = await projectWith([{ name: 'src', globs: ['src/**'] }]);
        const task = await taskOn(project, 'Tidy', ['src']);
        return { project, taskIds: [task.id] };
      },
    },
    {
      name: 'a task that is running',
      status: 409,
      arrange: async () => {
        const project = await projectWith(PAGES);
        const task = await taskOn(project, 'Settings: tidy', ['settings']);
        await api().post(`/tasks/${task.id}/start`, WorkstreamDto);
        return { project, taskIds: [task.id] };
      },
    },
    {
      name: 'an unfinished batch in Your folder',
      status: 409,
      arrange: async () => {
        const project = await projectWith(PAGES);
        const task = await taskOn(project, 'Settings: tidy', ['settings']);
        daemon.state.write((ctx) => {
          const batch = insertBatch(ctx, {
            projectId: project.id,
            title: 'Earlier',
            baseBranch: 'main',
          });
          transitionBatch(ctx, batch.id, { to: 'OPEN' });
        });
        return { project, taskIds: [task.id] };
      },
    },
    {
      name: 'more pages than the pass holds',
      status: 400,
      arrange: async () => {
        const project = await projectWith(PAGES);
        const settings = await taskOn(project, 'Settings: tidy', ['settings']);
        const people = await taskOn(project, 'People: tidy', ['people']);
        return { project, taskIds: [settings.id, people.id], pageCap: 1 };
      },
    },
    {
      name: 'a project on a ChatGPT account',
      status: 409,
      arrange: async () => {
        const project = await projectWith(PAGES);
        const task = await taskOn(project, 'Settings: tidy', ['settings']);
        const { account } = await api().post('/accounts', AccountCreatedDto, {
          kind: 'codex_signin',
          label: 'ChatGPT plan',
        });
        await api().patch(`/projects/${project.id}`, ProjectDto, { accountId: account.id });
        return { project, taskIds: [task.id] };
      },
    },
  ])('refuses $name with $status, opening nothing', async ({ arrange, status }) => {
    const { project, taskIds, pageCap } = await arrange();

    const res = await post(`/projects/${project.id}/passes`, {
      name: 'Polish',
      taskIds,
      ...(pageCap === undefined ? {} : { pageCap }),
      firstMessage: 'Tidy it',
    });

    expect(res.status).toBe(status);
    expect(daemon.state.db.select().from(schema.passes).all()).toEqual([]);
    expect(rawGit('symbolic-ref', '--short', 'HEAD')).toBe('main');
    for (const id of taskIds)
      expect(
        listTaskThread(daemon.state.db, TaskDto.shape.id.parse(id)).filter(
          (m) => m.author === 'builder',
        ),
      ).toEqual([]);
  });
});
