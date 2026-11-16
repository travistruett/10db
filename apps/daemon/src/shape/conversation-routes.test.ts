import {
  ConversationDto,
  ConversationFullDto,
  ConversationItemDto,
  ConversationItemsPage,
  ConversationLiveDto,
  ConversationItemAuthor,
  ConversationItemKind,
  mintId,
  type ConversationId,
} from '@10db/contracts';
import {
  insertBuilderMessage,
  insertSystemNotice,
  offerToAgent,
  insertItem,
  patchConversation,
  shapeConversation,
  taskConversationOf,
} from '@10db/db';
import { defineWebSocketHelper } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubServices } from '../../test/api-stub';
import { seedWorkstream, waitFor } from '../../test/fixtures';
import { createLiveRegistry, createTaskThread, writeFullOutput } from '../conversation';
import { createConversationServices } from '../daemon';
import { createApp } from '../api';
import { devUiMayRead, renderMayRead } from '../screens';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Sessions spec §10: the conversation routes, over a real store, the explore engine and Plan.

const TOKEN = 'ui-token';
const RENDER = 'render-token';
const DEV_UI = 'dev-ui-token';

/** No chat runs here: a Plan's routes never reach one. */
const noChat = (): never => {
  throw new Error('no chat in this test');
};
let f: ServiceFixture;
let conv: ConversationId;
let request: (
  path: string,
  init?: { method?: string; body?: unknown; token?: string },
) => Promise<Response>;

beforeEach(() => {
  f = createServiceFixture();
  conv = shapeConversation(f.c.store.db, f.c.shape.id).id;
  const app = createApp({
    startedAt: new Date(),
    allowedOrigins: [],
    token: TOKEN,
    onUnexpectedError: () => undefined,
    screens: {
      claim: () => Promise.resolve(null),
      deliver: () => false,
      refuse: () => false,
      tokenValid: (token) => token === RENDER,
      mayRead: renderMayRead,
      image: () => null,
    },
    devUi: { token: DEV_UI, mayRead: devUiMayRead },
    services: stubServices(
      createConversationServices({
        state: f.state,
        engine: f.engine,
        shape: f.service,
        chat: {
          send: noChat,
          post: noChat,
          sendNow: noChat,
          stop: noChat,
          redo: noChat,
          waiting: () => false,
        },
        files: () => Promise.resolve([]),
        dataDir: f.filesDir,
        laneLive: createLiveRegistry(),
        task: {
          // A task in no pass: its message is kept on its thread, and no page's session is handed it.
          post: (taskId, message, how) =>
            createTaskThread({
              state: f.state,
              dataDir: f.filesDir,
              pages: { deliver: () => Promise.reject(new Error('no page here')) },
            }).postTaskMessage(taskId, message, how),
        },
      }),
    ),
    upgradeWebSocket: defineWebSocketHelper(() => new Response(null, { status: 426 })),
    mcp: () => Promise.resolve(new Response('mcp')),
    builderMcp: () => Promise.resolve(new Response('builder')),
  });
  request = (path, init = {}) =>
    Promise.resolve(
      app.request(path, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${init.token ?? TOKEN}`,
          'content-type': 'application/json',
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
});
afterEach(async () => {
  await f.close();
});

const json = async <T>(res: Response, schema: { parse(v: unknown): T }): Promise<T> => {
  expect(res.status).toBeLessThan(300);
  return schema.parse(await res.json());
};

describe('the conversation routes', () => {
  it('reads the conversation and its items a page at a time', async () => {
    f.state.write((ctx) => {
      for (let i = 0; i < 205; i += 1)
        insertItem(ctx, conv, {
          author: ConversationItemAuthor.System,
          kind: ConversationItemKind.Notice,
          body: { text: `n${String(i)}` },
        });
    });
    const view = await json(await request(`/conversations/${conv}`), ConversationDto);
    expect(view).toMatchObject({ id: conv, owner: { kind: 'shape', id: f.c.shape.id } });
    const first = await json(await request(`/conversations/${conv}/items`), ConversationItemsPage);
    expect(first.items).toHaveLength(200);
    expect(first.nextAfterSeq).toBe(200);
    const next = await json(
      await request(`/conversations/${conv}/items?afterSeq=${String(first.nextAfterSeq)}`),
      ConversationItemsPage,
    );
    expect(next.items.map((i) => i.seq)).toEqual([201, 202, 203, 204, 205]);
    expect(next.nextAfterSeq).toBeNull();
  });

  it('answers what streams now, and takes a message into the queue', async () => {
    let finish = (): void => undefined;
    f.adapter.shapeBehaviour = (turn) => {
      turn.emit({ type: 'text_delta', itemId: 'r', offset: 0, text: 'Half a sen' });
      return new Promise((resolve) => {
        finish = () => {
          resolve({ text: 'Done.' });
        };
      });
    };
    const posted = await json(
      await request(`/conversations/${conv}/messages`, { method: 'POST', body: { text: 'Hello' } }),
      ConversationItemDto,
    );
    expect(posted).toMatchObject({ kind: 'message', text: 'Hello', deliveredAt: null });
    await waitFor(() => f.engine.live(conv).items.length === 1);
    const live = await json(await request(`/conversations/${conv}/live`), ConversationLiveDto);
    expect(live.items).toMatchObject([{ kind: 'agent_message', text: 'Half a sen' }]);
    const stopped = await json(
      await request(`/conversations/${conv}/stop`, { method: 'POST' }),
      ConversationDto,
    );
    expect(['stopping', 'idle_warm', 'running']).toContain(stopped.state);
    finish();
    await f.service.settled(f.c.shape.id);
  });

  it.each([
    ['no open Send now line', 'idle_cold', false],
    ['a paused account', 'paused_account', true],
  ] as const)('refuses Send Now with 409 for %s', async (_name, state, marker) => {
    f.state.write((ctx) => {
      patchConversation(ctx, conv, { state });
      if (marker)
        insertItem(ctx, conv, {
          author: ConversationItemAuthor.System,
          kind: ConversationItemKind.TurnMarker,
          body: { marker: 'send_now', resolvedAt: null },
        });
    });
    await f.restart();
    const res = await request(`/conversations/${conv}/send-now`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('serves an item’s whole output and text, and 404 when it keeps none', async () => {
    const item = f.state.write((ctx) =>
      insertItem(ctx, conv, {
        author: ConversationItemAuthor.Agent,
        kind: ConversationItemKind.AgentMessage,
        body: { text: 'short' },
      }),
    );
    expect((await request(`/conversations/${conv}/items/${item.id}/full`)).status).toBe(404);
    writeFullOutput(f.filesDir, conv, item.id, { output: 'all of it', text: 'long text' });
    expect(
      await json(
        await request(`/conversations/${conv}/items/${item.id}/full`),
        ConversationFullDto,
      ),
    ).toEqual({ output: 'all of it', patch: null, text: 'long text' });
    const page = await json(await request(`/conversations/${conv}/items`), ConversationItemsPage);
    expect(page.items.find((i) => i.id === item.id)?.hasFull).toBe(true);
  });

  it('answers 404 for a conversation it does not know, on every route', async () => {
    const unknown = mintId('Conversation');
    const item = mintId('ConversationItem');
    for (const [method, path] of [
      ['GET', `/conversations/${unknown}`],
      ['GET', `/conversations/${unknown}/items`],
      ['GET', `/conversations/${unknown}/live`],
      ['POST', `/conversations/${unknown}/messages`],
      ['POST', `/conversations/${unknown}/send-now`],
      ['POST', `/conversations/${unknown}/stop`],
      ['POST', `/conversations/${unknown}/redo`],
      ['GET', `/conversations/${unknown}/items/${item}/full`],
    ] as const)
      expect([
        method,
        path,
        (await request(path, method === 'GET' ? { method } : { method, body: { text: 'x' } }))
          .status,
      ]).toEqual([method, path, 404]);
  });

  it('reads a task’s items, takes a message to its thread, and leaves its state to the runner', async () => {
    const ws = seedWorkstream(f.c.store);
    f.state.write((ctx) => {
      insertBuilderMessage(ctx, ws.task.id, { body: 'First', files: [] });
      // A notice the daemon offers with Send to Agent, and one that offers nothing.
      offerToAgent(ctx, insertSystemNotice(ctx, ws.task.id, 'A check failed').id, 'Fix it');
      insertSystemNotice(ctx, ws.task.id, 'Started a fresh session');
    });
    const task = taskConversationOf(f.c.store.db, ws.task.id);
    if (task === null) throw new Error('no thread');
    const res = await request(`/conversations/${task.id}/messages`, {
      method: 'POST',
      body: { text: 'Hello' },
    });
    expect(res.status).toBe(202);
    const page = await json(
      await request(`/conversations/${task.id}/items`),
      ConversationItemsPage,
    );
    expect(
      page.items.map((i) =>
        i.kind === 'message' ? i.text : i.kind === 'notice' ? [i.text, i.offer] : i.kind,
      ),
    ).toEqual([
      'First',
      ['A check failed', 'send_to_agent'],
      ['Started a fresh session', undefined],
      'Hello',
    ]);
    for (const path of ['', '/stop', '/send-now'])
      expect(
        (await request(`/conversations/${task.id}${path}`, path === '' ? {} : { method: 'POST' }))
          .status,
      ).toBe(409);
  });

  it.each([
    ['a screen’s render token', RENDER],
    ['the dev UI’s token', DEV_UI],
  ])('lets %s read a Plan conversation, and no task’s', async (_name, token) => {
    const ws = seedWorkstream(f.c.store);
    f.state.write((ctx) => insertBuilderMessage(ctx, ws.task.id, { body: 'First', files: [] }));
    const task = taskConversationOf(f.c.store.db, ws.task.id);
    if (task === null) throw new Error('no thread');
    for (const path of ['', '/items', '/live']) {
      expect((await request(`/conversations/${conv}${path}`, { token })).status).toBe(200);
      expect((await request(`/conversations/${task.id}${path}`, { token })).status).toBe(403);
    }
  });
});

describe('a screen’s token when the conversation can’t be read', () => {
  it('is refused with 403 on an error that is not a missing conversation', async () => {
    const app = createApp({
      startedAt: new Date(),
      allowedOrigins: [],
      token: TOKEN,
      onUnexpectedError: () => undefined,
      screens: {
        claim: () => Promise.resolve(null),
        deliver: () => false,
        refuse: () => false,
        tokenValid: (token) => token === RENDER,
        mayRead: renderMayRead,
        image: () => null,
      },
      services: stubServices({
        conversationOwnerKind: () => {
          throw new Error('the store is closed');
        },
      }),
      upgradeWebSocket: defineWebSocketHelper(() => new Response(null, { status: 426 })),
      mcp: () => Promise.resolve(new Response('mcp')),
      builderMcp: () => Promise.resolve(new Response('builder')),
    });
    const res = await app.request(`/conversations/${mintId('Conversation')}`, {
      headers: { Authorization: `Bearer ${RENDER}` },
    });
    expect(res.status).toBe(403);
  });
});
