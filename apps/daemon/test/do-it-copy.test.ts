import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChatDto,
  ConversationItemDto,
  DoItResult,
  ProjectDto,
  TaskDto,
  type ProjectInput,
} from '@10db/contracts';
import {
  linkChatToTask,
  getBatch,
  getChat,
  getConversation,
  getTask,
  listItems,
  schema,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { createTempRepo, tempDir, waitFor, waitForAsync } from './fixtures';

// Sessions spec §7.3: Do It in a separate copy, through the real daemon, a real repository and the fake agent.

let data: { path: string; cleanup(): void };
let worktrees: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
let adapter: FakeAdapter;
beforeEach(async () => {
  data = tempDir('do it copy');
  worktrees = tempDir('do it copy worktrees');
  repo = createTempRepo();
  adapter = new FakeAdapter({});
  daemon = await boot();
});

/** The daemon on the test's data directory: a second call is a restart on the same database. */
function boot(): Promise<RunningDaemon> {
  return startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    worktreeRoot: worktrees.path,
    port: 0,
    adapter,
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    // A tick long enough that no lane starts while the test looks.
    tickMs: 3_600_000,
  });
}
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
  worktrees.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

async function project(extra: Partial<ProjectInput> = {}): Promise<ProjectDto> {
  return api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: null,
    delivery: 'pull_request',
    areas: [
      { name: 'api', globs: ['src/api/**'] },
      { name: 'rest', globs: ['**'], catchAll: true },
    ],
    ...extra,
  });
}

async function chatWithReply(made: ProjectDto): Promise<ChatDto> {
  adapter.shapeBehaviour = () => Promise.resolve({ text: 'Understood.' });
  const chat = await api().post('/chats', ChatDto, {
    projectId: made.id,
    model: null,
    tabPosition: 0,
  });
  await api().post(`/conversations/${chat.conversationId}/messages`, ConversationItemDto, {
    text: 'Knock out the login bug',
  });
  await waitForAsync(async () => {
    const [read] = (await api().get('/chats?open=1', z.array(ChatDto))).filter(
      (c) => c.id === chat.id,
    );
    return read?.conversation.state === 'idle_warm' || read?.conversation.state === 'idle_cold';
  });
  return chat;
}

const request = { place: 'worktree', title: 'Fix the login', brief: 'Retry once on a 401.' };

describe('Do It in a separate copy', () => {
  it('makes an ordinary task from base, leaves the folder alone, seals the chat and takes its tab', async () => {
    const made = await project();
    const chat = await chatWithReply(made);
    writeFileSync(join(repo.path, 'notes.md'), 'my notes\n');

    const done = await api().post(`/chats/${chat.id}/do-it`, DoItResult, request);

    if (!('taskId' in done)) throw new Error('Do It answered pending');
    expect(done.place).toBe('worktree');
    const task = getTask(daemon.state.db, done.taskId);
    expect(task).toMatchObject({
      title: 'Fix the login',
      description: 'Retry once on a 401.',
      areas: ['rest'],
      acceptanceCriteria: ["Does what the brief asks, and the project's checks pass."],
      workspaceMode: 'worktree',
    });
    expect(getConversation(daemon.state.db, chat.conversationId).state).toBe('sealed');
    expect(getChat(daemon.state.db, chat.id)).toMatchObject({
      mode: 'hands_on',
      taskId: done.taskId,
      tabPosition: null,
    });
    expect(
      daemon.state.db
        .select()
        .from(schema.chatTasks)
        .all()
        .map((r) => r.taskId),
    ).toEqual([done.taskId]);
    expect(
      listItems(daemon.state.db, chat.conversationId).filter(
        (i) => i.kind === 'notice' && JSON.stringify(i.body).includes('handed_to'),
      ),
    ).toHaveLength(1);
    expect(
      (await api().get('/chats?open=1', z.array(ChatDto))).find((c) => c.id === chat.id),
    ).toBeUndefined();
    // The uncommitted file stays in Your folder, and the copy is cut without it.
    expect(readFileSync(join(repo.path, 'notes.md'), 'utf8')).toBe('my notes\n');
    const batch = await waitFor(() => {
      const id = getTask(daemon.state.db, done.taskId).workstreamId;
      if (id === null) return undefined;
      const row = daemon.state.db
        .select()
        .from(schema.workstreams)
        .all()
        .find((w) => w.id === id);
      return row?.batchId == null ? undefined : getBatch(daemon.state.db, row.batchId);
    });
    if (batch.worktreePath !== null)
      expect(existsSync(join(batch.worktreePath, 'notes.md'))).toBe(false);
  });

  it('stops a running turn first, keeping its partial text, and a second submit makes no second task', async () => {
    const made = await project();
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      adapter.shapeBehaviour = async () => {
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
        return { text: 'Done.' };
      };
    });
    const chat = await api().post('/chats', ChatDto, {
      projectId: made.id,
      model: null,
      tabPosition: 0,
    });
    await api().post(`/conversations/${chat.conversationId}/messages`, ConversationItemDto, {
      text: 'Working on it',
    });
    await started;

    const twice = await Promise.all(
      [0, 1].map(async () => {
        const res = await fetch(`${daemon.url}/chats/${chat.id}/do-it`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
        return res.status;
      }),
    );
    release();

    expect(twice.sort()).toEqual([200, 409]);
    expect(daemon.state.db.select().from(schema.tasks).all()).toHaveLength(1);
    expect(getChat(daemon.state.db, chat.id).tabPosition).toBeNull();
    expect(getConversation(daemon.state.db, chat.conversationId).state).toBe('sealed');
  });

  it('finishes a Do It the daemon stopped after the chat row: seals it, starts its task, keeps one notice', async () => {
    const made = await project();
    const chat = await chatWithReply(made);
    const task = await api().post(`/projects/${made.id}/tasks`, TaskDto, {
      title: 'Fix the login',
      acceptanceCriteria: ['x'],
      areas: ['rest'],
      workspaceMode: 'worktree',
      dependsOn: [],
    });
    daemon.state.write((ctx) => {
      linkChatToTask(ctx, chat.id, { taskId: task.id, passId: null });
    });
    await daemon.stop();

    daemon = await boot();

    await waitFor(() => getTask(daemon.state.db, task.id).workstreamId !== null || undefined);
    expect(getConversation(daemon.state.db, chat.conversationId).state).toBe('sealed');
    expect(getChat(daemon.state.db, chat.id).tabPosition).toBeNull();
    expect(
      listItems(daemon.state.db, chat.conversationId).filter(
        (i) => i.kind === 'notice' && JSON.stringify(i.body).includes('handed_to'),
      ),
    ).toHaveLength(1);
  });
});
