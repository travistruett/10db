import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  mintId,
  ProjectDto,
  TaskDto,
  TaskSessionDto,
  WHOLE_PROJECT_PAGE,
  WorkstreamChangesDto,
  WorkstreamDto,
} from '@10db/contracts';
import {
  endPassTurn,
  insertChat,
  insertConversation,
  insertPass,
  insertPassTurn,
  recordChatTask,
  setPassTurnKept,
  settlePassTurn,
  insertBatch,
  insertInboxItem,
  insertWorkstream,
  leavePass,
  markTasksMadeByPass,
  patchProject,
  schema,
  patchWorkstream,
  transitionBatch,
  transitionWorkstream,
} from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { raiseBuilderCheck } from '../src/runner';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, isolatedGitEnv, tempDir, waitForAsync } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('workstream changes');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    // A tick long enough that a started task stays where the test left it.
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

async function get(path: string) {
  const res = await fetch(`${daemon.url}${path}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

async function startedWorkstream() {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: null,
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
  const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'change things',
    acceptanceCriteria: ['x'],
    areas: ['src'],
    dependsOn: [],
  });
  return api().post(`/tasks/${task.id}/start`, WorkstreamDto);
}

describe('GET /workstreams/:id/changes', () => {
  it("answers the workstream's changes from its checkout", async () => {
    const ws = await startedWorkstream();
    const baseHead = rawGit('rev-parse', 'HEAD');
    daemon.state.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, { baseHead });
    });
    writeFileSync(join(repo.path, 'feature.txt'), 'hello\nworld\n');
    rawGit('add', 'feature.txt');
    rawGit('commit', '-q', '-m', 'add feature');

    const changes = await api().get(`/workstreams/${ws.id}/changes`, WorkstreamChangesDto);

    expect(changes.baseHead).toBe(baseHead);
    expect(changes.head).toBe(rawGit('rev-parse', 'HEAD'));
    expect(changes.commits).toEqual([changes.head]);
    expect(changes.truncated).toBe(false);
    expect(changes.diff).toContain('+world');
    expect(changes.files).toEqual([{ path: 'feature.txt', added: 2, removed: 0 }]);
  });

  it('answers 404 for a workstream that does not exist', async () => {
    const res = await get(`/workstreams/${mintId('Workstream')}/changes`);
    expect(res.status).toBe(404);
  });

  it('answers 409 for a workstream that has not started in a checkout', async () => {
    const ws = await startedWorkstream();
    const res = await get(`/workstreams/${ws.id}/changes`);
    expect(res.status).toBe(409);
  });

  it('answers 404 when its checkout is gone', async () => {
    const ws = await startedWorkstream();
    daemon.state.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, { baseHead: rawGit('rev-parse', 'HEAD') });
    });
    rmSync(repo.path, { recursive: true, force: true });

    const res = await get(`/workstreams/${ws.id}/changes`);
    expect(res.status).toBe(404);
  });

  it('answers 409 when the base is not a commit of the checkout', async () => {
    const ws = await startedWorkstream();
    daemon.state.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, { baseHead: 'a'.repeat(40) });
    });

    const res = await get(`/workstreams/${ws.id}/changes`);
    expect(res.status).toBe(409);
  });

  it('shows a path with a space and a newline whole', async () => {
    const ws = await startedWorkstream();
    const baseHead = rawGit('rev-parse', 'HEAD');
    daemon.state.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, { baseHead });
    });
    writeFileSync(join(repo.path, 'sp ace\nline.txt'), 'odd\n');
    rawGit('add', 'sp ace\nline.txt');
    rawGit('commit', '-q', '-m', 'odd name');

    const changes = await api().get(`/workstreams/${ws.id}/changes`, WorkstreamChangesDto);

    expect(changes.files).toEqual([{ path: 'sp ace\nline.txt', added: 1, removed: 0 }]);
    expect(changes.diff).toContain('+odd');
  });

  describe('a workstream that waits for the builder', () => {
    const waitOnCheck = (wsId: WorkstreamDto['id'], projectId: ProjectDto['id'], head: string) => {
      daemon.state.write((ctx) => {
        for (const to of ['RUNNING', 'VERIFYING', 'WAITING_HUMAN'] as const)
          transitionWorkstream(ctx, wsId, { to, fence: null });
        const card = raiseBuilderCheck(ctx, {
          workstreamId: wsId,
          projectId,
          taskTitle: 'change things',
          baseHead: rawGit('rev-parse', 'HEAD~1'),
          head,
          commits: [head],
        });
        patchWorkstream(ctx, wsId, null, {
          nextAction: { kind: 'builder_review', inboxId: card.id },
        });
      });
    };

    it('is read at the head its check card showed, not at a later head', async () => {
      const ws = await startedWorkstream();
      const baseHead = rawGit('rev-parse', 'HEAD');
      daemon.state.write((ctx) => {
        patchWorkstream(ctx, ws.id, null, { baseHead });
      });
      writeFileSync(join(repo.path, 'shown.txt'), 'shown\n');
      rawGit('add', 'shown.txt');
      rawGit('commit', '-q', '-m', 'shown');
      const shown = rawGit('rev-parse', 'HEAD');
      waitOnCheck(ws.id, ws.projectId, shown);
      writeFileSync(join(repo.path, 'later.txt'), 'later\n');
      rawGit('add', 'later.txt');
      rawGit('commit', '-q', '-m', 'later');

      const changes = await api().get(`/workstreams/${ws.id}/changes`, WorkstreamChangesDto);

      expect(changes.head).toBe(shown);
      expect(changes.commits).toEqual([shown]);
      expect(changes.files.map((f) => f.path)).toEqual(['shown.txt']);
      expect(changes.diff).not.toContain('later');
    });

    it('is read at the head of the card the workstream points at, not another live check card', async () => {
      const ws = await startedWorkstream();
      const baseHead = rawGit('rev-parse', 'HEAD');
      daemon.state.write((ctx) => {
        patchWorkstream(ctx, ws.id, null, { baseHead });
      });
      writeFileSync(join(repo.path, 'pointed.txt'), 'pointed\n');
      rawGit('add', 'pointed.txt');
      rawGit('commit', '-q', '-m', 'pointed');
      const pointed = rawGit('rev-parse', 'HEAD');
      writeFileSync(join(repo.path, 'other.txt'), 'other\n');
      rawGit('add', 'other.txt');
      rawGit('commit', '-q', '-m', 'other');
      const other = rawGit('rev-parse', 'HEAD');
      daemon.state.write((ctx) => {
        // A stale card sits first in line; the card the workstream points at is the second.
        insertInboxItem(ctx, {
          projectId: ws.projectId,
          kind: 'check',
          title: 'stale',
          body: 'stale',
          options: [],
          recommendation: null,
          category: 'product',
          urgency: 'normal',
          detail: { workstreamId: ws.id, baseHead, head: other, commits: [other] },
          foldKey: null,
          targets: [{ workstreamId: ws.id, sessionId: null }],
        });
      });
      waitOnCheck(ws.id, ws.projectId, pointed);

      const changes = await api().get(`/workstreams/${ws.id}/changes`, WorkstreamChangesDto);

      expect(changes.head).toBe(pointed);
      expect(changes.files.map((f) => f.path)).toEqual(['pointed.txt']);
    });

    it('raising the check again brings a card that shows an older head to the new one', async () => {
      const ws = await startedWorkstream();
      const baseHead = rawGit('rev-parse', 'HEAD');
      daemon.state.write((ctx) => {
        patchWorkstream(ctx, ws.id, null, { baseHead });
      });
      writeFileSync(join(repo.path, 'first.txt'), 'first\n');
      rawGit('add', 'first.txt');
      rawGit('commit', '-q', '-m', 'first');
      const first = rawGit('rev-parse', 'HEAD');
      waitOnCheck(ws.id, ws.projectId, first);
      writeFileSync(join(repo.path, 'second.txt'), 'second\n');
      rawGit('add', 'second.txt');
      rawGit('commit', '-q', '-m', 'second');
      const second = rawGit('rev-parse', 'HEAD');
      const card = daemon.state.write((ctx) =>
        raiseBuilderCheck(ctx, {
          workstreamId: ws.id,
          projectId: ws.projectId,
          taskTitle: 'change things',
          baseHead,
          head: second,
          commits: [first, second],
        }),
      );
      daemon.state.write((ctx) => {
        patchWorkstream(ctx, ws.id, null, {
          nextAction: { kind: 'builder_review', inboxId: card.id },
        });
      });

      const changes = await api().get(`/workstreams/${ws.id}/changes`, WorkstreamChangesDto);

      expect(changes.head).toBe(second);
      expect(card.detail).toMatchObject({ head: second, commits: [first, second] });
      expect(card.body).toContain('2 commits');
    });
  });

  describe('in a batch', () => {
    /** A workstream of a batch in a project of `mode`, with a fresh base head recorded. */
    const batchWorkstream = async (mode: 'shared' | 'worktree', worktreePath: string | null) => {
      const project = await api().post('/projects', ProjectDto, {
        name: 'batched',
        repoPath: repo.path,
        gateCommand: null,
        areas: [{ name: 'src', globs: ['src/**'] }],
        ...(mode === 'worktree'
          ? { delivery: 'pull_request', prTitlePrefix: 'feat(app)', workspaceMode: 'worktree' }
          : {}),
      });
      const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'change things',
        acceptanceCriteria: ['x'],
        areas: ['src'],
        dependsOn: [],
      });
      const baseHead = rawGit('rev-parse', 'HEAD');
      return daemon.state.write((ctx) => {
        const batch = insertBatch(ctx, {
          projectId: project.id,
          title: 'batch',
          baseBranch: 'main',
          ...(worktreePath === null ? {} : { worktreePath }),
        });
        const ws = insertWorkstream(ctx, task.id, {
          first: { model: 'claude-sonnet-5-5', effort: 'medium' },
          batchId: batch.id,
        });
        patchWorkstream(ctx, ws.id, null, { baseHead });
        return ws;
      });
    };

    const finish = (
      batchId: NonNullable<Awaited<ReturnType<typeof batchWorkstream>>['batchId']>,
    ) => {
      daemon.state.write((ctx) => {
        transitionBatch(ctx, batchId, { to: 'OPEN', reason: 'test' });
        transitionBatch(ctx, batchId, { to: 'ABANDONED', reason: 'test' });
      });
    };

    it.each([
      { name: 'a worktree project whose batch has finished', mode: 'worktree' as const },
      {
        name: 'a project that went back to shared after its batch finished',
        mode: 'shared' as const,
      },
    ])('answers 409 for $name, rather than reading the main checkout', async ({ mode }) => {
      const ws = await batchWorkstream('worktree', null);
      if (ws.batchId === null) throw new Error('no batch');
      finish(ws.batchId);
      daemon.state.write((ctx) => patchProject(ctx, ws.projectId, { workspaceMode: mode }));

      const res = await get(`/workstreams/${ws.id}/changes`);
      expect(res.status).toBe(409);
    });

    it('reads a shared batch from the project checkout', async () => {
      const ws = await batchWorkstream('shared', null);

      const res = await get(`/workstreams/${ws.id}/changes`);
      expect(res.status).toBe(200);
    });

    it('reads the project checkout for an open batch with no worktree path', async () => {
      // A shared batch has no path; the project may have gone to worktree mode only once none was unfinished,
      // so the state to cover is an open null-path batch under a worktree-mode project.
      const ws = await batchWorkstream('worktree', null);
      if (ws.batchId === null) throw new Error('no batch');
      const batchId = ws.batchId;
      daemon.state.write((ctx) => {
        transitionBatch(ctx, batchId, { to: 'OPEN', reason: 'test' });
      });

      const res = await get(`/workstreams/${ws.id}/changes`);
      expect(res.status).toBe(200);
    });

    it("reads a worktree batch from the batch's worktree", async () => {
      const worktree = join(repo.path, '..', `worktree-${String(process.pid)}`);
      rawGit('worktree', 'add', '-q', '-b', 'batch-branch', worktree);
      const inWorktree = (...args: string[]) =>
        execFileSync('git', ['-C', worktree, ...args], {
          env: isolatedGitEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
          .toString()
          .trim();
      writeFileSync(join(worktree, 'in-worktree.txt'), 'there\n');
      inWorktree('add', 'in-worktree.txt');
      inWorktree('commit', '-q', '-m', 'in the worktree');
      const ws = await batchWorkstream('worktree', worktree);

      try {
        const changes = await api().get(`/workstreams/${ws.id}/changes`, WorkstreamChangesDto);
        expect(changes.head).toBe(inWorktree('rev-parse', 'HEAD'));
        expect(changes.files.map((f) => f.path)).toEqual(['in-worktree.txt']);
      } finally {
        rmSync(worktree, { recursive: true, force: true });
      }
    });
  });
});

/** A commit off HEAD holding `files` that no branch names, as a pass turn's kept commit is. */
function keptCommit(files: Record<string, string>): string {
  const paths = Object.keys(files);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo.path, path, '..'), { recursive: true });
    writeFileSync(join(repo.path, path), content);
  }
  rawGit('add', ...paths);
  const tree = rawGit('write-tree');
  rawGit('rm', '-q', '--cached', ...paths);
  for (const path of paths) rmSync(join(repo.path, path));
  return rawGit('commit-tree', '--no-gpg-sign', tree, '-p', 'HEAD', '-m', 'kept');
}

/** A pass task with two kept turns and a third the page is working on. */
async function passTaskWithTurns() {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: null,
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
  const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'Fix the login',
    acceptanceCriteria: ['x'],
    areas: ['src'],
    dependsOn: [],
  });
  const startSha = rawGit('rev-parse', 'HEAD');
  const first = keptCommit({ 'src/a.ts': 'a\n' });
  const second = keptCommit({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  const made = daemon.state.write((ctx) => {
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
    patchWorkstream(ctx, ws.id, null, { baseHead: startSha });
    for (const kept of [first, second]) {
      const turn = insertPassTurn(ctx, {
        taskId: task.id,
        workstreamId: ws.id,
        sessionId: null,
        messageId: null,
      });
      endPassTurn(ctx, turn.id, { ending: 'ready', replyBody: 'Done.' });
      setPassTurnKept(ctx, turn.id, { keptSha: kept, keptBaseSha: startSha, sharedSeq: null });
      settlePassTurn(ctx, turn.id);
    }
    insertPassTurn(ctx, { taskId: task.id, workstreamId: ws.id, sessionId: null, messageId: null });
    return { pass, ws };
  });
  return { project, task, startSha, first, second, ...made };
}

describe('GET /workstreams/:id/changes?scope=', () => {
  it('shows every kept turn for all and the latest one for last, with the page working on a third', async () => {
    const { ws, startSha, first, second } = await passTaskWithTurns();

    const all = await api().get(`/workstreams/${ws.id}/changes?scope=all`, WorkstreamChangesDto);
    const last = await api().get(`/workstreams/${ws.id}/changes?scope=last`, WorkstreamChangesDto);

    expect([all.baseHead, all.head]).toEqual([startSha, second]);
    expect(all.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect([last.baseHead, last.head]).toEqual([first, second]);
    expect(last.files.map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it("answers a copy's all and last as its work is today, and refuses an unknown scope", async () => {
    const ws = await startedWorkstream();
    daemon.state.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, { baseHead: rawGit('rev-parse', 'HEAD') });
    });
    writeFileSync(join(repo.path, 'feature.txt'), 'hello\n');
    rawGit('add', 'feature.txt');
    rawGit('commit', '-q', '-m', 'add feature');

    // The lane's launch may still be settling the run's base: read until the three answers are taken together.
    const read = (query: string) =>
      api().get(`/workstreams/${ws.id}/changes${query}`, WorkstreamChangesDto);
    await waitForAsync(async () => {
      const [today, all, last] = [
        await read(''),
        await read('?scope=all'),
        await read('?scope=last'),
      ];
      return (
        JSON.stringify(today) === JSON.stringify(all) &&
        JSON.stringify(all) === JSON.stringify(last)
      );
    });
    expect((await get(`/workstreams/${ws.id}/changes?scope=weird`)).status).toBe(400);
  });
});

describe('GET /tasks/:taskId/session', () => {
  it("reads a pass task's place, branch, run and the chat it came from, after a second Do It", async () => {
    const { project, task, pass, ws } = await passTaskWithTurns();
    daemon.state.write((ctx) => {
      const conv = insertConversation(ctx, {
        projectId: project.id,
        owner: { kind: ConversationOwnerKind.Chat, id: mintId('Chat') },
        profile: ConversationProfile.Explore,
        state: ConversationState.IdleCold,
      });
      const chatId = mintId('Chat');
      insertChat(ctx, {
        id: chatId,
        projectId: project.id,
        conversationId: conv.id,
        title: 'Login bug',
        tabPosition: 0,
      });
      recordChatTask(ctx, chatId, task.id);
    });

    const session = await api().get(`/tasks/${task.id}/session`, TaskSessionDto);

    expect(session).toMatchObject({
      taskId: task.id,
      title: 'Fix the login',
      place: 'pass',
      passId: pass.id,
      workstreamId: ws.id,
      fromChat: { title: 'Login bug' },
      pullRequest: null,
    });
    expect(session.branch).toBe('10db/polish-abcdef');
  });

  it('still reads a pass of one as a pass once the pass closed and its task left it', async () => {
    const { task, pass, ws } = await passTaskWithTurns();
    daemon.state.write((ctx) => {
      ctx.tx
        .update(schema.tasks)
        .set({ areas: [WHOLE_PROJECT_PAGE.name] })
        .where(eq(schema.tasks.id, task.id))
        .run();
      markTasksMadeByPass(ctx, pass.id, [task.id]);
      leavePass(ctx, task.id);
    });

    const session = await api().get(`/tasks/${task.id}/session`, TaskSessionDto);

    expect(session).toMatchObject({ place: 'pass', passId: pass.id, workstreamId: ws.id });
    expect(session.branch).toBe('10db/polish-abcdef');
  });

  it("reads a copy's place, and no chat for a task nobody handed over", async () => {
    const ws = await startedWorkstream();

    const session = await api().get(`/tasks/${ws.taskId}/session`, TaskSessionDto);

    expect(session).toMatchObject({ place: 'copy', passId: null, fromChat: null });
    expect(session.workstreamId).toBe(ws.id);
  });
});
