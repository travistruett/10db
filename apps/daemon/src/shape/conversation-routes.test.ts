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
  insertItem,
  patchConversation,
  shapeConversation,
  taskConversationOf,
} from '@10db/db';
import { defineWebSocketHelper } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubServices } from '../../test/api-stub';
import { seedWorkstream, waitFor } from '../../test/fixtures';
import { writeFullOutput } from '../conversation';
import { createConversationServices } from '../daemon';
import { createApp } from '../api';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Sessions spec §10: the conversation routes, over a real store, the explore engine and Plan.

const TOKEN = 'ui-token';
let f: ServiceFixture;
let conv: ConversationId;
let request: (path: string, init?: { method?: string; body?: unknown }) => Promise<Response>;

beforeEach(() => {
  f = createServiceFixture();
  conv = shapeConversation(f.c.store.db, f.c.shape.id).id;
  const app = createApp({
    startedAt: new Date(),
    allowedOrigins: [],
    token: TOKEN,
    onUnexpectedError: () => undefined,
    services: stubServices(
      createConversationServices({
        state: f.state,
        engine: f.engine,
        shape: f.service,
        dataDir: f.filesDir,
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
        headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
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

  it('reads a task’s conversation, and refuses a message to it with 409', async () => {
    const ws = seedWorkstream(f.c.store);
    f.state.write((ctx) => insertBuilderMessage(ctx, ws.task.id, { body: 'First', files: [] }));
    const task = taskConversationOf(f.c.store.db, ws.task.id);
    if (task === null) throw new Error('no thread');
    await json(await request(`/conversations/${task.id}`), ConversationDto);
    const res = await request(`/conversations/${task.id}/messages`, {
      method: 'POST',
      body: { text: 'Hello' },
    });
    expect(res.status).toBe(409);
  });
});
