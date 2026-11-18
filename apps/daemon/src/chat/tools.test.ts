import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { InboxItemDto } from '@10db/contracts';
import {
  ChatDto,
  ChatToolName,
  ConversationDto,
  DecisionItem,
  PrincipleItem,
  ProjectDto,
  TaskDto,
  TaskId,
} from '@10db/contracts';
import { chatMadeTask, getDecisionDto, getPrinciple, listInbox, setChatWork } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiClient } from '../../test/api-client';
import { createTempRepo, isolatedGitEnv, tempDir, waitForAsync } from '../../test/fixtures';
import { seedProfiles } from '../../test/seed-profiles';
import { ManualClock, type Clock } from '../clock';
import { startDaemon, type RunningDaemon } from '../daemon';
import { FakeAdapter, type FakeShapeTurn } from '../sessions';
import { BUILDER_KEPT_TASK, BUILDER_NO_ANSWER, BUILDER_STOPPED } from './tools';

// Sessions spec §6.6: a chat's agent reaches every builder tool through 10db's own /mcp by its
// session's token, held to the chat's project; removing or retiring work it didn't make asks the
// builder on a card. Through a started daemon on the fake adapter and a real SQLite file.

let dir: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
let adapter: FakeAdapter;
let api: ReturnType<typeof apiClient>;
let project: ProjectDto;

/** Starts the daemon on the test's data directory, on `clock` when one is given. */
async function boot(clock?: Clock): Promise<void> {
  daemon = await startDaemon({
    sandbox: null,
    dataDir: dir.path,
    port: 0,
    adapter,
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    ...(clock === undefined ? {} : { clock }),
  });
  seedProfiles(daemon.state);
  api = apiClient(daemon.url, daemon.token);
}

beforeEach(async () => {
  dir = tempDir('daemon');
  repo = createTempRepo();
  adapter = new FakeAdapter({});
  await boot();
  project = await api.post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
});
afterEach(async () => {
  await daemon?.stop();
  repo.cleanup();
  dir.cleanup();
});

const running = (): RunningDaemon => {
  if (daemon === null) throw new Error('no daemon is running');
  return daemon;
};

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

type Call = (name: string, args: Record<string, unknown>) => Promise<string>;

/** A tool's answer as the agent reads it: the text of its one block. */
const ToolText = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
});

/**
 * The chat's agent takes a turn that runs `work` against /mcp with the session's own token; the
 * promise settles once the turn has ended.
 */
async function agentTurn(chat: ChatDto, work: (call: Call, turn: FakeShapeTurn) => Promise<void>) {
  const outcome: { failure: Error | null; ended: boolean } = { failure: null, ended: false };
  adapter.shapeBehaviour = async (turn) => {
    const client = await connect(turn.spec.mcp.url, turn.spec.mcp.token);
    try {
      await work(async (name, args) => {
        const result = ToolText.parse(await client.callTool({ name, arguments: args }));
        return result.content.map((c) => c.text).join('');
      }, turn);
    } catch (error) {
      outcome.failure = error instanceof Error ? error : new Error('the turn failed');
    } finally {
      await client.close();
    }
    outcome.ended = true;
    return { text: 'Done.' };
  };
  await api.post(`/conversations/${chat.conversationId}/messages`, z.unknown(), { text: 'Go on.' });
  await waitForAsync(async () => {
    const conv = await api.get(`/conversations/${chat.conversationId}`, ConversationDto);
    return outcome.ended && (conv.state === 'idle_warm' || conv.state === 'idle_cold')
      ? conv
      : false;
  });
  if (outcome.failure !== null) throw outcome.failure;
}

const newChat = () =>
  api.post('/chats', ChatDto, { projectId: project.id, model: null, tabPosition: 0 });

const builderTask = (title = 'Builder work') =>
  api.post(`/projects/${project.id}/tasks`, TaskDto, {
    title,
    acceptanceCriteria: ['It works'],
    areas: ['src'],
  });

const principle = (of: ProjectDto, statement = 'Retry a 401 once') =>
  api.post(`/projects/${of.id}/principles`, PrincipleItem, { statement });

const openCards = () =>
  listInbox(running().state.db, { states: ['OPEN'] }).filter((c) => c.kind === 'permission');

async function answer(card: InboxItemDto, choice: 'allow_once' | 'deny'): Promise<void> {
  await api.post(`/inbox/${card.id}/answer`, z.unknown(), { choice });
}

const tasksOf = async () =>
  (await api.get(`/projects/${project.id}/tasks`, z.array(TaskDto))).filter(
    (t) => t.status === 'open',
  );

describe("a chat's tools on /mcp", () => {
  it('lists every builder tool and set_title, and no lane or Plan tool', async () => {
    const chat = await newChat();
    let names: string[] = [];
    await agentTurn(chat, async (_call, turn) => {
      const client = await connect(turn.spec.mcp.url, turn.spec.mcp.token);
      names = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
    });
    expect(new Set(names)).toEqual(new Set(Object.values(ChatToolName)));
  });

  it("files a task in the chat's own project whatever project the call names, and records it", async () => {
    const chat = await newChat();
    const other = await api.post('/projects', ProjectDto, {
      name: 'other',
      repoPath: createTempRepo().path,
      gateCommand: 'true',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    let filed = '';
    await agentTurn(chat, async (call) => {
      filed = await call('create_task', {
        projectId: other.id,
        title: 'Retry login once on a 401',
        acceptanceCriteria: ['A 401 retries once'],
        areas: ['src'],
      });
    });
    const result = z
      .object({ kind: z.literal('task'), taskId: TaskId, column: z.string() })
      .parse(JSON.parse(filed));
    expect(result.column).toBe('Ready');
    expect((await tasksOf()).map((t) => t.title)).toEqual(['Retry login once on a 401']);
    expect(chatMadeTask(running().state.db, chat.id, result.taskId)).toBe(true);
  });

  it("edits the builder's task with the old values for Undo, and starts a task with no card", async () => {
    const chat = await newChat();
    const task = await builderTask('Old title');
    let edited = '';
    let started = '';
    await agentTurn(chat, async (call) => {
      edited = await call('edit_task', { taskId: task.id, title: 'New title', why: task.why });
      started = await call('start_task', { taskId: task.id });
    });
    expect(JSON.parse(edited)).toEqual({
      kind: 'task_edit',
      taskId: task.id,
      title: 'New title',
      previous: { title: 'Old title' },
    });
    expect(JSON.parse(started)).toEqual({ kind: 'start', taskId: task.id, started: true });
    expect(openCards()).toEqual([]);
  });

  it('an edit of the kinds keeps the kinds the builder took off among the old values', async () => {
    const chat = await newChat();
    const task = await builderTask('Kinds');
    let edited = '';
    await agentTurn(chat, async (call) => {
      edited = await call('edit_task', { taskId: task.id, kinds: [{ key: 'docs' }] });
    });
    const result = z
      .object({ previous: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(edited));
    expect(result.previous).toEqual({ kinds: task.kinds, kindsOff: task.kindsOff });
  });

  it("asks before removing the builder's task: Deny keeps it, Allow once removes it", async () => {
    const chat = await newChat();
    const task = await builderTask();
    const said: string[] = [];
    const turn = agentTurn(chat, async (call) => {
      said.push(await call('remove_task', { taskId: task.id }));
      said.push(await call('remove_task', { taskId: task.id }));
    });
    const first = await waitForAsync(() => Promise.resolve(openCards()[0]));
    expect(openCards()).toHaveLength(1);
    expect(first.detail).toMatchObject({ conversationId: chat.conversationId });
    expect((await api.get(`/conversations/${chat.conversationId}`, ConversationDto)).state).toBe(
      'waiting_card',
    );
    await answer(first, 'deny');
    const second = await waitForAsync(() =>
      Promise.resolve(openCards().find((c) => c.id !== first.id)),
    );
    expect((await tasksOf()).map((t) => t.id)).toEqual([task.id]);
    await answer(second, 'allow_once');
    await turn;
    expect(said[0]).toContain(BUILDER_KEPT_TASK);
    expect(await tasksOf()).toEqual([]);
  });

  it("removes the chat's own task with no card, and asks before retiring a record", async () => {
    const chat = await newChat();
    const rule = await principle(project);
    const retired: string[] = [];
    const turn = agentTurn(chat, async (call) => {
      const filed = JSON.parse(
        await call('create_task', { title: 'Mine', acceptanceCriteria: ['x'], areas: ['src'] }),
      ) as { taskId: string };
      await call('remove_task', { taskId: filed.taskId });
      retired.push(await call('retire_knowledge', { id: rule.id, reason: 'Ended' }));
    });
    const card = await waitForAsync(() => Promise.resolve(openCards()[0]));
    expect(card.title).toBe('Retire a principle?');
    expect(card.body).toContain(`“Retry a 401 once” (${rule.id})`);
    expect(await tasksOf()).toEqual([]);
    await answer(card, 'deny');
    await turn;
  });

  it('refuses a record of another project, with no card, and leaves it as it was', async () => {
    const chat = await newChat();
    const other = await api.post('/projects', ProjectDto, {
      name: 'other',
      repoPath: createTempRepo().path,
      gateCommand: 'true',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const rule = await principle(other);
    const decision = await api.post(`/projects/${other.id}/decisions`, DecisionItem, {
      question: 'Which queue?',
      choice: 'BullMQ',
      rationale: 'It retries',
    });
    const rows = [
      { tool: 'retire_knowledge', args: { id: rule.id, reason: 'Ended' } },
      { tool: 'withdraw_knowledge', args: { id: rule.id, reason: 'Misheard' } },
      { tool: 'withdraw_knowledge', args: { id: decision.id, reason: 'Misheard' } },
      { tool: 'supersede_knowledge', args: { id: decision.id, choice: 'SQS' } },
      { tool: 'supersede_knowledge', args: { id: rule.id, statement: 'Retry twice' } },
    ];
    const said: string[] = [];
    await agentTurn(chat, async (call) => {
      for (const row of rows) said.push(await call(row.tool, row.args));
    });
    for (const text of said)
      expect(text).toContain('That record is in another project; this chat works in its own.');
    expect(openCards()).toEqual([]);
    expect(getPrinciple(running().state.db, rule.id).state).toBe('current');
    expect(getDecisionDto(running().state.db, decision.id).state).toBe('current');
  });

  it("renames an agent-titled chat cut at a word, and leaves the builder's name", async () => {
    const chat = await newChat();
    await agentTurn(chat, async (call) => {
      await call('set_title', { title: 'Login fails after sleep because the token refresh races' });
    });
    expect((await api.get('/chats?open=1', z.array(ChatDto)))[0]?.title).toBe(
      'Login fails after sleep',
    );
    await api.patch(`/chats/${chat.id}`, ChatDto, { title: 'Mine' });
    await agentTurn(chat, async (call) => {
      await call('set_title', { title: 'Something else' });
    });
    expect((await api.get('/chats?open=1', z.array(ChatDto)))[0]?.title).toBe('Mine');
  });

  it('withdraws a waiting card on Stop, and the call answers that the builder stopped', async () => {
    const chat = await newChat();
    const task = await builderTask();
    let said = '';
    const turn = agentTurn(chat, async (call) => {
      said = await call('remove_task', { taskId: task.id });
    });
    const card = await waitForAsync(() => Promise.resolve(openCards()[0]));
    await api.post(`/conversations/${chat.conversationId}/stop`, z.unknown());
    await turn;
    expect(said).toContain(BUILDER_STOPPED);
    expect(listInbox(running().state.db, { states: ['OPEN'] }).map((c) => c.id)).not.toContain(
      card.id,
    );
    expect((await tasksOf()).map((t) => t.id)).toEqual([task.id]);
  });

  it("withdraws a card the builder leaves past the project's human wait, and a late Allow removes nothing", async () => {
    await running().stop();
    const clock = new ManualClock();
    await boot(clock);
    const task = await builderTask();
    let said = '';
    const chat = await newChat();
    const turn = agentTurn(chat, async (call) => {
      said = await call('remove_task', { taskId: task.id });
    });
    const card = await waitForAsync(() => Promise.resolve(openCards()[0]));
    clock.advance(project.humanWaitMinutes * 60_000 - 1);
    expect(openCards().map((c) => c.id)).toEqual([card.id]);
    clock.advance(1);
    await turn;
    expect(said).toContain(BUILDER_NO_ANSWER);
    expect(openCards()).toEqual([]);
    const late = await fetch(`${running().url}/inbox/${card.id}/answer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${running().token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'allow_once' }),
    });
    expect(late.status).toBe(409);
    expect((await tasksOf()).map((t) => t.id)).toEqual([task.id]);
  });

  it("refuses the UI token on /mcp, the chat's token on /builder/mcp, and an archived chat's token", async () => {
    const chat = await newChat();
    let token = '';
    let url = '';
    await agentTurn(chat, (_call, turn) => {
      token = turn.spec.mcp.token;
      url = turn.spec.mcp.url;
      return Promise.resolve();
    });
    const post = (path: string, bearer: string) =>
      fetch(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect((await post(url, running().token)).status).toBe(401);
    expect((await post(`${running().url}/builder/mcp`, token)).status).toBe(401);
    await api.post(`/chats/${chat.id}/archive`, ChatDto);
    expect((await post(url, token)).status).toBe(401);
  });
});

// Sessions spec §7.3: a turn that holds Your folder branches and commits through the daemon, and its tools
// stop working the moment the turn gives the folder back.
describe("a chat's git tools through the daemon", () => {
  const gitOf = (...args: string[]) =>
    execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
      .toString()
      .trim();

  it('branches and commits what the turn edited with the builder’s identity, then refuses once the turn is over', async () => {
    const chat = await newChat();
    // The git tools change the checkout, so the session works there.
    running().state.write((ctx) => setChatWork(ctx, chat.id, null, { place: 'here' }));
    let token = '';
    let url = '';
    await agentTurn(chat, async (call, turn) => {
      token = turn.spec.mcp.token;
      url = turn.spec.mcp.url;
      writeFileSync(join(repo.path, 'login.ts'), 'export const retry = 1;\n');
      await call('make_branch', { name: 'retry-login' });
      const answer = JSON.parse(
        await call('commit_changes', { message: 'Retry login once', paths: ['login.ts'] }),
      ) as { done: boolean; sha: string };
      expect(answer.done).toBe(true);
    });
    expect(gitOf('branch', '--show-current')).toBe('retry-login');
    expect(gitOf('show', '--name-only', '--format=', 'HEAD')).toBe('login.ts');
    expect(gitOf('log', '-1', '--format=%an <%ae>|%s')).toBe(
      '10db test <test@10db.invalid>|Retry login once',
    );
    // The turn ended and the folder went back: the warm session's tool no longer changes git.
    const client = await connect(url, token);
    const late = ToolText.parse(
      await client.callTool({ name: 'commit_changes', arguments: { message: 'late' } }),
    );
    await client.close();
    expect(late.content.map((c) => c.text).join('')).toMatch(/does not have your checkout/);
    expect(gitOf('rev-list', '--count', 'HEAD')).toBe('2');
  });
});
