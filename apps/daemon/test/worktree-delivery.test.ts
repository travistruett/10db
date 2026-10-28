import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BatchDto,
  BatchStartResult,
  DaemonEvent,
  EventType,
  InboxItemDto,
  ProjectDto,
  TaskDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { parseWorktreeList } from '../src/git';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import { FakeGh } from './fake-gh';
import {
  createTempRepoWithOrigin,
  githubOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  tempDir,
  waitForAsync,
} from './fixtures';

const TITLES = ['Alpha', 'Beta', 'Gamma'] as const;
const fileOf = (title: string) => `src/ui/${title.toLowerCase()}.txt`;

/**
 * Each lane writes and commits its own file in the `ui` area, then asks a question and waits for the
 * answer while it still holds its claim, so the test sees all three lanes running at once.
 */
function lane(title: string): FakeScriptBook[string][number] {
  const path = fileOf(title);
  const op = title.toLowerCase().padEnd(8, '0');
  return [
    { do: 'tool', toolName: 'Write', input: { file_path: path, content: `${path}\n` } },
    {
      do: 'mcp',
      tool: 'commit',
      args: { opId: `op-${op}-c`, paths: [path], message: `Add ${path}` },
    },
    {
      do: 'mcp',
      tool: 'ask_human',
      args: {
        opId: `op-${op}-q`,
        category: 'design',
        question: `Ship ${title} as it is?`,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
      },
    },
    { do: 'turn_complete' },
  ];
}
const BOOK: FakeScriptBook = Object.fromEntries(TITLES.map((t) => [t, [lane(t)]]));

let data: { path: string; cleanup(): void };
let worktrees: { path: string; cleanup(): void };
let remote: ReturnType<typeof createTempRepoWithOrigin>;
let network: ReturnType<typeof githubOrigin>;
let gh: FakeGh;
let daemon: RunningDaemon | null = null;
beforeEach(() => {
  data = tempDir('worktree-daemon');
  worktrees = tempDir('worktrees');
  remote = createTempRepoWithOrigin();
  network = githubOrigin(remote.repo.path, remote.origin.path);
  gh = new FakeGh();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  remote.cleanup();
  network.cleanup();
  worktrees.cleanup();
  data.cleanup();
});

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv() })
    .toString()
    .trim();

async function start() {
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter(BOOK),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    gh,
    networkEnv: () => ({ ...NETWORK_ENV, GIT_CONFIG_GLOBAL: network.global }),
    worktreeRoot: worktrees.path,
  });
  const running = daemon;
  const api = apiClient(running.url, running.token);
  const project = await api.post('/projects', ProjectDto, {
    name: 'shop',
    repoPath: remote.repo.path,
    gateCommand: 'true',
    flowId: await quickFlowId(api),
    maxLanes: 3,
    areas: [{ name: 'ui', globs: ['src/ui/**'] }],
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
    workspaceMode: 'worktree',
  });
  const tasks: TaskDto[] = [];
  for (const title of TITLES)
    tasks.push(
      await api.post(`/projects/${project.id}/tasks`, TaskDto, {
        title,
        acceptanceCriteria: ['it exists'],
        areas: ['ui'],
      }),
    );
  /** The raw answer, for a status the typed client would throw on. */
  const request = (method: string, path: string, body: unknown) =>
    fetch(`${running.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${running.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  /** Waits for one open question from each named lane and answers them all. */
  const answerQuestions = async (titles: readonly string[]) => {
    const asked = await waitForAsync(async () => {
      const open = (await api.get('/inbox?state=OPEN', z.array(InboxItemDto))).filter(
        (i) => i.kind === 'question',
      );
      return open.length === titles.length ? open : undefined;
    }, 30_000);
    expect(asked.map((i) => i.title).sort()).toEqual(titles.map((t) => `Ship ${t} as it is?`));
    for (const item of asked)
      await api.post(`/inbox/${item.id}/answer`, z.unknown(), { choice: 'Yes' });
  };
  return { api, project, tasks, request, answerQuestions };
}

describe('worktree mode through the daemon', () => {
  it('runs three tasks at once in three worktrees, ships three PRs and leaves the main checkout as it was', async () => {
    const { api, project, tasks, answerQuestions } = await start();
    const main = remote.repo.path;
    // The builder works on a branch of their own, with an edit not yet committed.
    git(main, 'switch', '-q', '-c', 'mine');
    writeFileSync(join(main, 'README.md'), '# fixture, edited by hand\n');
    const snapshot = () => ({
      head: git(main, 'rev-parse', 'HEAD'),
      branch: git(main, 'symbolic-ref', 'HEAD'),
      index: git(main, 'ls-files', '-s'),
      status: git(main, 'status', '--porcelain'),
      readme: readFileSync(join(main, 'README.md')),
    });
    const before = snapshot();

    const started = await api.post(`/projects/${project.id}/batches`, BatchStartResult, {
      title: 'Three widgets',
      taskIds: tasks.map((t) => t.id),
    });
    expect(started.map((b) => b.state)).toEqual(['CUTTING', 'CUTTING', 'CUTTING']);
    expect(started.map((b) => b.title).sort()).toEqual([...TITLES]);

    await answerQuestions(TITLES);
    const shipped = await waitForAsync(async () => {
      const batches = await api.get(`/projects/${project.id}/batches`, z.array(BatchDto));
      // A shipped batch's worktree is removed after SHIPPED; its path clears once it is gone.
      return batches.length === 3 &&
        batches.every((b) => b.state === 'SHIPPED' && b.worktreePath === null)
        ? batches
        : undefined;
    }, 60_000);

    // The three lanes held `ui` at the same time: every claim was taken before any was released.
    const events = await api.get('/events?after=0&limit=1000', z.array(DaemonEvent));
    const firstRelease = events.findIndex((e) => e.type === EventType.ClaimReleased);
    expect(firstRelease).toBeGreaterThan(-1);
    expect(
      events
        .slice(0, firstRelease)
        .filter((e) => e.type === EventType.ClaimAcquired && e.data['name'] === 'ui'),
    ).toHaveLength(3);

    // Three pull requests, one per task, each from its own branch.
    const creates = gh.prCreates();
    expect(creates.map((c) => c.title).sort()).toEqual([
      'feat(app): alpha',
      'feat(app): beta',
      'feat(app): gamma',
    ]);
    expect(new Set(creates.map((c) => c.head)).size).toBe(3);
    expect(creates.map((c) => c.head).sort()).toEqual(shipped.map((b) => b.branch).sort());

    // Each branch on origin holds its own task's file and not the others'.
    const onOrigin = git(
      remote.origin.path,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/10db/',
    )
      .split('\n')
      .filter(Boolean);
    expect(onOrigin).toHaveLength(3);
    for (const batch of shipped) {
      const files = git(remote.origin.path, 'ls-tree', '-r', '--name-only', batch.branch ?? '')
        .split('\n')
        .filter((f) => f.startsWith('src/'));
      expect(files).toEqual([fileOf(batch.title)]);
    }

    // No worktree is left: git lists only the main checkout, and the root holds only the project's
    // empty directory.
    const listed = parseWorktreeList(git(main, 'worktree', 'list', '--porcelain', '-z') + '\0');
    expect(listed.map((e) => e.path)).toEqual([realpathSync(main)]);
    const levels = readdirSync(worktrees.path);
    expect(levels).toHaveLength(1);
    const level = join(worktrees.path, levels[0] ?? '');
    const projectDirs = readdirSync(level);
    expect(projectDirs).toHaveLength(1);
    expect(readdirSync(join(level, projectDirs[0] ?? ''))).toEqual([]);

    // The main checkout is exactly as the builder left it.
    expect(snapshot()).toEqual(before);
    expect(before.branch).toBe('refs/heads/mine');
  }, 90_000);
});

describe('worktree mode settings through a real store', () => {
  it('PATCH refuses worktree mode with local delivery (400)', async () => {
    const { project, request } = await start();
    const res = await request('PATCH', `/projects/${project.id}`, { delivery: 'local' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('needs pull request delivery');
  });

  it('PATCH refuses a mode change while a batch is unfinished (409)', async () => {
    const { api, project, tasks, request, answerQuestions } = await start();
    const [alpha] = tasks;
    if (!alpha) throw new Error('no Alpha task');
    await api.post(`/projects/${project.id}/batches`, BatchStartResult, {
      title: 'Alpha',
      taskIds: [alpha.id],
    });
    // The lane waits on its question, so its batch is OPEN for as long as the test needs.
    await waitForAsync(async () =>
      (await api.get('/inbox?state=OPEN', z.array(InboxItemDto))).some((i) => i.kind === 'question')
        ? true
        : undefined,
    );
    const res = await request('PATCH', `/projects/${project.id}`, { workspaceMode: 'shared' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('workspace mode');
    await answerQuestions(['Alpha']);
  });
});
