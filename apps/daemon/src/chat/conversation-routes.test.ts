import {
  ConversationLiveDto,
  ConversationState,
  EventType,
  FolderDto,
  FolderHolderKind,
  TakeoverCommandDto,
  TakeoverDto,
  TakeoverPreviewDto,
  UpstreamError,
  type ChatDto,
  WorkstreamState,
} from '@10db/contracts';
import {
  insertTask,
  insertWorkstream,
  listItemFiles,
  listItems,
  schema,
  setChatWork,
} from '@10db/db';
import { eq } from 'drizzle-orm';
import { defineWebSocketHelper } from 'hono/ws';
import { afterEach, describe, expect, it } from 'vitest';
import { stubServices } from '../../test/api-stub';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { createLiveRegistry } from '../conversation';
import { createApp } from '../api';
import { createChatApiServices, createConversationServices } from '../daemon';
import { createPendingOpens } from '../pass';
import { silentLogger } from '../log';

// Sessions spec §10: the message route's chat branch, over real HTTP, a real store and the engine on
// the fake adapter.

const TOKEN = 'ui-token-for-tests';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let w: ChatWorld;
afterEach(async () => {
  await w.close();
});

function appOf(world: ChatWorld) {
  return createApp({
    startedAt: new Date(),
    allowedOrigins: [],
    token: TOKEN,
    onUnexpectedError: () => undefined,
    services: stubServices({
      ...createChatApiServices({
        state: world.state,
        chat: world.chat,
        work: world.work,
        takeover: world.takeover,
        folderHold: world.folderHold,
        pendingOpens: createPendingOpens({ state: world.state }),
        doItPreview: () => Promise.reject(new Error('not read here')),
        doIt: () => Promise.reject(new Error('not done here')),
        changes: () => Promise.reject(new Error('not read here')),
        // The world's checkout is no repository: its branch can't be read.
        git: () => Promise.reject(new Error('not a repository')),
        now: () => new Date(),
        log: silentLogger,
      }),
      ...createConversationServices({
        state: world.state,
        engine: world.engine,
        shape: {
          send: () => {
            throw new Error('no Plan here');
          },
          redo: () => Promise.reject(new Error('no Plan here')),
          sendNow: () => undefined,
        },
        chat: world.chat,
        files: () => Promise.resolve([]),
        dataDir: world.dataDir,
        laneLive: createLiveRegistry(),
        task: { post: () => Promise.reject(new Error('no task here')) },
      }),
    }),
    upgradeWebSocket: defineWebSocketHelper(() => new Response(null, { status: 426 })),
    mcp: () => Promise.resolve(new Response('mcp')),
  });
}

describe("a chat's message route", () => {
  it('stores the message queued with its mentions, titles the chat from its first line, and starts a turn', async () => {
    w = chatWorld();
    const chat = w.open();
    const res = await appOf(w).request(`/conversations/${chat.conversationId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '@src/login.ts why does it fail?', mentions: ['src/login.ts'] }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ kind: 'message', mentions: ['src/login.ts'] });
    await w.engine.settled(chat.conversationId);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    expect(w.chat.get(chat.id).title).toBe('@src/login.ts why does it fail?');
  });

  it('titles a picture-only message "New session", and keeps its picture', async () => {
    w = chatWorld();
    const chat = w.open();
    const form = new FormData();
    form.append('text', '');
    form.append('picture', new File([PNG], 'shot.png', { type: 'image/png' }));
    const res = await appOf(w).request(`/conversations/${chat.conversationId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    expect(res.status).toBe(202);
    const [message] = listItems(w.state.db, chat.conversationId);
    expect(listItemFiles(w.state.db, [message?.id ?? never()])).toHaveLength(1);
    expect(w.chat.get(chat.id).title).toBe('New session');
  });

  it('refuses a mention outside the checkout with a 400', async () => {
    w = chatWorld();
    const chat = w.open();
    const res = await appOf(w).request(`/conversations/${chat.conversationId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', mentions: ['../secrets'] }),
    });
    expect(res.status).toBe(400);
  });
});

/** A task of the project running in Your folder, as the scheduler leaves it once it started. */
function runningTask(title: string): void {
  w.state.write((ctx) => {
    const task = insertTask(ctx, w.project.id, {
      title,
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    const ws = insertWorkstream(ctx, task.id, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    ctx.tx
      .update(schema.workstreams)
      .set({ state: WorkstreamState.Running, workspaceMode: 'shared' })
      .where(eq(schema.workstreams.id, ws.id))
      .run();
  });
}

/** The task ends and says so, as the runner's transition does. */
function laneEnds(): void {
  w.state.write((ctx) => {
    ctx.tx
      .update(schema.workstreams)
      .set({ state: WorkstreamState.Failed })
      .where(eq(schema.workstreams.state, WorkstreamState.Running))
      .run();
    ctx.emit({
      type: EventType.WorkstreamChanged,
      entityType: 'workstream',
      entityId: 'wst_x',
      data: {},
    });
  });
}

const headers = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function send(chatConversation: string, body: Record<string, unknown>): Promise<Response> {
  return appOf(w).request(`/conversations/${chatConversation}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'edit notes.md', ...body }),
  });
}

async function live(conversation: string): Promise<ConversationLiveDto> {
  const res = await appOf(w).request(`/conversations/${conversation}/live`, { headers });
  return ConversationLiveDto.parse(await res.json());
}

describe('the folder and a chat that meets it held', () => {
  it('names the holders of Your folder, the words and whether a chat is kept out', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const res = await appOf(w).request(`/projects/${w.project.id}/folder`, { headers });
    expect(res.status).toBe(200);
    const folder = FolderDto.parse(await res.json());
    expect(folder.branch).toBeNull();
    expect(folder.holders).toEqual([
      expect.objectContaining({
        kind: FolderHolderKind.Lane,
        name: 'Bump vite',
        words: expect.stringContaining('Bump vite') as string,
        keepsChatOut: true,
      }),
    ]);
  });

  it('parks a send with folder wait, and runs it once the task ends', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    w.here(chat.id);
    expect((await send(chat.conversationId, { folder: 'wait' })).status).toBe(202);
    expect((await live(chat.conversationId)).waitingForFolder).toBe(true);
    expect(w.engine.view(chat.conversationId).state).toBe(ConversationState.IdleCold);
    laneEnds();
    await w.engine.settled(chat.conversationId);
    expect((await live(chat.conversationId)).waitingForFolder).toBe(false);
    expect(w.adapter.shapeSessions).toHaveLength(1);
  });

  it.each([
    { name: 'a reading chat (row 7)', place: null },
    { name: 'a chat on its own branch (row 30)', place: 'branch' as const },
  ])('runs a send with folder wait at once under a lane, for $name', async ({ place }) => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    if (place !== null)
      w.store.write((ctx) => setChatWork(ctx, chat.id, null, { place, branch: 'fix' }));
    expect((await send(chat.conversationId, { folder: 'wait' })).status).toBe(202);
    expect((await live(chat.conversationId)).waitingForFolder).toBe(false);
    await w.engine.settled(chat.conversationId);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
  });

  it('runs a send with folder read_only at once, and without one', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    await send(chat.conversationId, { folder: 'read_only' });
    expect((await live(chat.conversationId)).waitingForFolder).toBe(false);
    await w.engine.settled(chat.conversationId);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    await send(chat.conversationId, {});
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
  });

  it('reads the folder choice from a multipart form too', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    w.here(chat.id);
    const form = new FormData();
    form.append('text', 'edit notes.md');
    form.append('folder', 'wait');
    const res = await appOf(w).request(`/conversations/${chat.conversationId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    expect(res.status).toBe(202);
    expect(w.folderHold.waiting(chat.id)).toBe(true);
  });

  it('refuses a folder choice that is neither wait nor read_only', async () => {
    w = chatWorld();
    const chat = w.open();
    expect((await send(chat.conversationId, { folder: 'now' })).status).toBe(400);
  });

  it('answers stop-waiting for a chat that waits for nothing with the chat, and starts nothing', async () => {
    w = chatWorld();
    const chat = w.open();
    const stopped = await appOf(w).request(`/chats/${chat.id}/stop-waiting`, {
      method: 'POST',
      headers,
    });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ id: chat.id });
    expect(w.adapter.shapeSessions).toHaveLength(0);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
  });

  it('runs what waits reading only on stop-waiting, and the edited message of a redo carries its own choice', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    w.here(chat.id);
    await send(chat.conversationId, { folder: 'wait' });
    const stopped = await appOf(w).request(`/chats/${chat.id}/stop-waiting`, {
      method: 'POST',
      headers,
    });
    expect(stopped.status).toBe(200);
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(w.adapter.shapeSessions).toHaveLength(1);

    const redo = await appOf(w).request(`/conversations/${chat.conversationId}/redo`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'edit again', folder: 'wait' }),
    });
    expect(redo.status).toBe(202);
    expect(w.folderHold.waiting(chat.id)).toBe(true);
  });
});

function never(): never {
  throw new Error('no message stored');
}

describe("a chat's takeover routes", () => {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  const call = (world: ChatWorld, method: string, path: string, withToken = true) =>
    appOf(world).request(path, { method, headers: withToken ? headers : {} });

  /** A chat with one finished turn, kept off the folder so its session stays warm. */
  async function talked(): Promise<ChatDto> {
    const chat = w.open();
    const held = w.folderHold.reserveGit(w.project.id, 'warming up');
    w.chat.send(chat.conversationId, { text: 'Hello', mentions: [], pictures: [] });
    await w.engine.settled(chat.conversationId);
    if (held.reserved) w.folderHold.releaseGit(held.token);
    return chat;
  }

  it('answers 401 with no token', async () => {
    w = chatWorld();
    const chat = w.open();
    const base = `/conversations/${chat.conversationId}`;
    for (const [method, path] of [
      ['POST', '/takeover'],
      ['POST', '/takeover/command'],
      ['POST', '/hand-back'],
      ['GET', '/takeover'],
      ['GET', '/takeover/preview'],
    ] as const)
      expect((await call(w, method, base + path, false)).status).toBe(401);
  });

  it('opens with the line, reads back, previews and hands back', async () => {
    w = chatWorld();
    const chat = await talked();
    const base = `/conversations/${chat.conversationId}`;
    expect((await call(w, 'GET', `${base}/takeover`)).status).toBe(404);
    const preview = TakeoverPreviewDto.parse(
      await (await call(w, 'GET', `${base}/takeover/preview`)).json(),
    );
    expect(preview.refusal).toBeNull();
    const opened = await call(w, 'POST', `${base}/takeover`);
    expect(opened.status).toBe(200);
    expect(TakeoverDto.parse(await opened.json()).line).toMatch(/^\/bin\/sh -c /);
    expect(TakeoverDto.parse(await (await call(w, 'GET', `${base}/takeover`)).json()).app).toBe(
      'copy',
    );
    expect(
      TakeoverCommandDto.parse(await (await call(w, 'POST', `${base}/takeover/command`)).json())
        .line,
    ).toMatch(/^\/bin\/sh -c /);
    expect((await call(w, 'POST', `${base}/hand-back`)).status).toBe(204);
    expect((await call(w, 'GET', `${base}/takeover`)).status).toBe(404);
  });

  it('answers 409 with the refusal’s words, and 502 when the terminal does not open', async () => {
    w = chatWorld();
    const chat = await talked();
    const base = `/conversations/${chat.conversationId}`;
    const notIn = await call(w, 'POST', `${base}/hand-back`);
    expect(notIn.status).toBe(409);
    expect(await notIn.text()).toContain('Not in your terminal');
    w.folderHold.reserveGit(w.project.id, 'a switch back');
    const held = await call(w, 'POST', `${base}/takeover`);
    expect(held.status).toBe(409);
    expect(await held.text()).toContain('Your folder is in use by');
  });

  it('answers 502 when the terminal does not open', async () => {
    w = chatWorld();
    w.terminal.app = 'iterm';
    w.terminal.openerFails = new UpstreamError("iTerm isn't installed or didn't open.");
    const chat = await talked();
    const res = await call(w, 'POST', `/conversations/${chat.conversationId}/takeover`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("iTerm isn't installed");
  });
});
