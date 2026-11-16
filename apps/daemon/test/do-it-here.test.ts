import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChatDto,
  ConversationItemDto,
  DoItResult,
  FolderDto,
  PassAbandonedDto,
  PassCloseAnswerDto,
  PassClosePreviewDto,
  ProjectDto,
  type ProjectInput,
} from '@10db/contracts';
import {
  getBatch,
  getChat,
  getConversation,
  getPass,
  listPassTasks,
  listTaskThread,
  schema,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { createTempRepo, isolatedGitEnv, tempDir, waitFor, waitForAsync } from './fixtures';

// Sessions spec §7.3: Do It in Your folder opens a pass of one, through the real daemon, a real
// repository and the fake agent.

const TITLE = 'Fix the login';
const BRIEF = 'Retry once on a 401.';
/** The page's first turn: it writes a file and ends Ready. */
const SCRIPTS = {
  [TITLE]: [
    [
      { do: 'consume' },
      { do: 'tool', toolName: 'Write', input: { file_path: 'login.ts', content: 'retry\n' } },
      { do: 'turn_complete', text: 'Retried once.' },
      { do: 'await_message', contains: 'never sent' },
    ],
  ],
} as const;

let data: { path: string; cleanup(): void };
let worktrees: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
let adapter: FakeAdapter;
beforeEach(async () => {
  data = tempDir('do it here');
  worktrees = tempDir('do it here worktrees');
  repo = createTempRepo();
  adapter = new FakeAdapter(SCRIPTS as never);
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    worktreeRoot: worktrees.path,
    port: 0,
    adapter,
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    tickMs: 50,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
  worktrees.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], {
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();

async function post(path: string, body: unknown = {}) {
  const res = await fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

async function project(extra: Partial<ProjectInput> = {}): Promise<ProjectDto> {
  return api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: null,
    delivery: 'pull_request',
    areas: [{ name: 'rest', globs: ['**'], catchAll: true }],
    ...extra,
  });
}

const idle = (state: string | undefined) => state === 'idle_warm' || state === 'idle_cold';

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
    return idle(read?.conversation.state);
  });
  return chat;
}

/** A chat whose turn is running and stays so until `release`. */
async function chatHolding(made: ProjectDto): Promise<{ chat: ChatDto; release: () => void }> {
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
  return {
    chat,
    release: () => {
      release();
    },
  };
}

const here = { place: 'here', title: TITLE, brief: BRIEF };
const folderOf = (made: ProjectDto) => api().get(`/projects/${made.id}/folder`, FolderDto);
const branchOf = (pass: { batchId: Parameters<typeof getBatch>[1] | null }): string | null => {
  if (pass.batchId === null) throw new Error('the pass has no batch');
  return getBatch(daemon.state.db, pass.batchId).branch;
};
const onlyPass = () => {
  const [pass] = daemon.state.db.select().from(schema.passes).all();
  if (pass === undefined) throw new Error('no pass was opened');
  return pass;
};

describe('Do It in Your folder', () => {
  it.each([
    { delivery: 'pull_request', branch: 'feature' },
    { delivery: 'pull_request', branch: 'main' },
    { delivery: 'local', branch: 'main' },
  ] as const)(
    'opens a pass of one returning to $branch on a $delivery project, the brief its first message',
    async ({ delivery, branch }) => {
      if (branch !== 'main') git('switch', '-q', '-c', branch);
      const made = await project({ delivery });
      const chat = await chatWithReply(made);
      writeFileSync(join(repo.path, 'notes.md'), 'my notes\n');

      const done = await api().post(`/chats/${chat.id}/do-it`, DoItResult, here);

      if (!('taskId' in done)) throw new Error('Do It answered pending');
      expect(done.place).toBe('here');
      const pass = onlyPass();
      expect(pass).toMatchObject({ state: 'OPEN', returnBranch: branch });
      expect(git('symbolic-ref', '--short', 'HEAD')).toBe(branchOf(pass));
      // The dirt stays in the folder, and the chat keeps its tab and its session.
      expect(readFileSync(join(repo.path, 'notes.md'), 'utf8')).toBe('my notes\n');
      expect(getChat(daemon.state.db, chat.id)).toMatchObject({
        mode: 'hands_on',
        taskId: done.taskId,
        passId: pass.id,
        tabPosition: 0,
      });
      expect(getConversation(daemon.state.db, chat.conversationId).state).not.toBe('sealed');
      expect(listPassTasks(daemon.state.db, pass.id).map((t) => t.id)).toEqual([done.taskId]);
      expect(
        listTaskThread(daemon.state.db, done.taskId)
          .filter((m) => m.author === 'builder')
          .map((m) => m.body),
      ).toEqual([BRIEF]);
    },
  );

  it.each([
    {
      what: 'a merge',
      begin: () => {
        git('switch', '-q', '-c', 'other');
        writeFileSync(join(repo.path, 'README.md'), 'other\n');
        git('commit', '-q', '-am', 'other side');
        git('switch', '-q', 'main');
        writeFileSync(join(repo.path, 'README.md'), 'main side\n');
        git('commit', '-q', '-am', 'main side');
        try {
          git('merge', 'other');
        } catch {
          // The conflict is what leaves the merge in progress.
        }
      },
    },
    {
      what: 'a bisect',
      begin: () => {
        writeFileSync(join(repo.path, 'README.md'), 'second\n');
        git('commit', '-q', '-am', 'second');
        git('bisect', 'start', 'HEAD', 'HEAD~1');
      },
    },
  ])('refuses in the middle of $what, stopping nothing and opening no pass', async ({ begin }) => {
    const made = await project();
    const { chat, release } = await chatHolding(made);
    begin();

    const res = await post(`/chats/${chat.id}/do-it`, here);

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/middle of/);
    expect(daemon.state.db.select().from(schema.passes).all()).toEqual([]);
    // The turn goes on: it was never stopped.
    expect(getConversation(daemon.state.db, chat.conversationId).state).toBe('running');
    release();
    await waitForAsync(async () => {
      const [read] = (await api().get('/chats?open=1', z.array(ChatDto))).filter(
        (c) => c.id === chat.id,
      );
      return idle(read?.conversation.state);
    });
  });

  it("stops the chat's own running turn and opens once its folder is given back", async () => {
    const made = await project();
    const { chat, release } = await chatHolding(made);

    const done = await api().post(`/chats/${chat.id}/do-it`, DoItResult, here);
    release();

    expect(done).toMatchObject({ place: 'here' });
    expect(onlyPass()).toMatchObject({ state: 'OPEN' });
    expect((await folderOf(made)).holders.map((h) => h.kind)).not.toContain('chat_turn');
  });

  it('puts the earlier uncommitted file back as it was when the pass is abandoned', async () => {
    const made = await project();
    const chat = await chatWithReply(made);
    writeFileSync(join(repo.path, 'notes.md'), 'my notes\n');
    await api().post(`/chats/${chat.id}/do-it`, DoItResult, here);
    const pass = onlyPass();
    writeFileSync(join(repo.path, 'login.ts'), 'half\n');

    await api().post(`/passes/${pass.id}/abandon`, PassAbandonedDto);

    await waitFor(() => getPass(daemon.state.db, pass.id).state === 'ABANDONED' || undefined);
    expect(git('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(readFileSync(join(repo.path, 'notes.md'), 'utf8')).toBe('my notes\n');
    expect(existsSync(join(repo.path, 'login.ts'))).toBe(false);
  });

  it.each([
    { delivery: 'pull_request', branch: 'feature' },
    { delivery: 'local', branch: 'main' },
  ] as const)(
    'lands as a pass lands: after Sign Off and Close Pass the folder is on $branch with the page committed ($delivery)',
    async ({ delivery, branch }) => {
      if (branch !== 'main') git('switch', '-q', '-c', branch);
      const made = await project({ delivery });
      const chat = await chatWithReply(made);
      const done = await api().post(`/chats/${chat.id}/do-it`, DoItResult, here);
      if (!('taskId' in done)) throw new Error('Do It answered pending');
      const pass = onlyPass();
      await waitFor(() => {
        const [task] = listPassTasks(daemon.state.db, pass.id);
        return (
          daemon.state.db
            .select()
            .from(schema.workstreams)
            .all()
            .some((w) => w.taskId === task?.id && w.state === 'WAITING_HUMAN') || undefined
        );
      }, 20_000);

      const signed = await post(`/passes/${pass.id}/tasks/${done.taskId}/sign-off`);
      expect(signed.status).toBe(202);
      await waitFor(
        () =>
          daemon.state.db
            .select()
            .from(schema.workstreams)
            .all()
            .some((w) => w.taskId === done.taskId && w.state === 'DONE') || undefined,
        20_000,
      );
      const preview = await api().get(`/passes/${pass.id}/close`, PassClosePreviewDto);
      const closed = await post(`/passes/${pass.id}/close`, {
        token: preview.token,
        pages: [],
        files: [],
        shared: [],
      });
      expect(PassCloseAnswerDto.parse(closed.body)).toMatchObject({ outcome: 'closing' });

      await waitFor(
        () => getPass(daemon.state.db, pass.id).state === 'SETTLED' || undefined,
        20_000,
      );
      expect(git('symbolic-ref', '--short', 'HEAD')).toBe(branch);
      expect(readFileSync(join(repo.path, 'login.ts'), 'utf8')).toBe('retry\n');
      expect(git('status', '--porcelain')).toBe('');
      expect(git('log', '-1', '--format=%s')).toBe(TITLE);
    },
  );
});

describe('Do It in Your folder while chats hold it', () => {
  it("refuses at once when another chat's turn holds the folder, naming it", async () => {
    const made = await project();
    const mine = await chatWithReply(made);
    const other = await chatHolding(made);

    const res = await post(`/chats/${mine.id}/do-it`, here);
    other.release();

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/in use by the chat/);
    expect(daemon.state.db.select().from(schema.passes).all()).toEqual([]);
  });

  it("stops the other chat's turn and opens with stop_turns, this chat's queue running", async () => {
    const made = await project();
    const mine = await chatWithReply(made);
    const other = await chatHolding(made);

    const done = await api().post(`/chats/${mine.id}/do-it`, DoItResult, {
      ...here,
      whenBusy: 'stop_turns',
    });
    other.release();

    expect(done).toMatchObject({ place: 'here' });
    expect(onlyPass()).toMatchObject({ state: 'OPEN' });
    adapter.shapeBehaviour = () => Promise.resolve({ text: 'Reading only.' });
    await api().post(`/conversations/${mine.conversationId}/messages`, ConversationItemDto, {
      text: 'And then?',
    });
    await waitForAsync(async () => {
      const [read] = (await api().get('/chats?open=1', z.array(ChatDto))).filter(
        (c) => c.id === mine.id,
      );
      return idle(read?.conversation.state);
    });
  });

  it('answers pending for wait, names the chat, refuses Do It and archive for it until Cancel, and opens when the turn ends', async () => {
    const made = await project();
    const mine = await chatWithReply(made);
    const other = await chatHolding(made);

    const pending = await api().post(`/chats/${mine.id}/do-it`, DoItResult, {
      ...here,
      whenBusy: 'wait',
    });

    expect(pending).toEqual({ pending: true });
    expect((await folderOf(made)).pendingOpen).toMatchObject({ name: TITLE });
    for (const place of ['here', 'worktree'])
      expect((await post(`/chats/${mine.id}/do-it`, { ...here, place })).status).toBe(409);
    const archived = await post(`/chats/${mine.id}/archive`);
    expect(archived.status).toBe(409);
    expect(JSON.stringify(archived.body)).toMatch(/waiting to open for this chat/);

    other.release();
    await waitFor(() => daemon.state.db.select().from(schema.passes).all()[0] ?? undefined);
    expect(onlyPass()).toMatchObject({ state: 'OPEN' });
    expect(getChat(daemon.state.db, mine.id)).toMatchObject({ passId: onlyPass().id });
  });

  it('lets the chat be archived again once the waiting open is cancelled', async () => {
    const made = await project();
    const mine = await chatWithReply(made);
    const other = await chatHolding(made);
    await api().post(`/chats/${mine.id}/do-it`, DoItResult, { ...here, whenBusy: 'wait' });

    await fetch(`${daemon.url}/projects/${made.id}/pending-open`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    other.release();

    expect((await post(`/chats/${mine.id}/archive`)).status).toBe(200);
    expect(daemon.state.db.select().from(schema.passes).all()).toEqual([]);
  });
});
