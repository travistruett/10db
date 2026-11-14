import { listItems, listItemFiles } from '@10db/db';
import { defineWebSocketHelper } from 'hono/ws';
import { afterEach, describe, expect, it } from 'vitest';
import { stubServices } from '../../test/api-stub';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { createApp } from '../api';
import { createConversationServices } from '../daemon';

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
    services: stubServices(
      createConversationServices({
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
      }),
    ),
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

function never(): never {
  throw new Error('no message stored');
}
