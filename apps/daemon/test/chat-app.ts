import { defineWebSocketHelper } from 'hono/ws';
import { createApp } from '../src/api';
import { createChatApiServices } from '../src/daemon';
import { silentLogger } from '../src/log';
import { createPendingOpens } from '../src/pass';
import { stubServices } from './api-stub';
import type { ChatWorld } from './chat-world';

/** The token the app under test accepts. */
export const CHAT_APP_TOKEN = 'ui-token-for-tests';

/** A chat world's own routes, served by the real app over its real services. */
export function chatApp(world: ChatWorld) {
  return createApp({
    startedAt: new Date(),
    allowedOrigins: [],
    token: CHAT_APP_TOKEN,
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
        git: () => Promise.reject(new Error('not a repository')),
        now: () => new Date(),
        log: silentLogger,
      }),
    }),
    upgradeWebSocket: defineWebSocketHelper(() => new Response(null, { status: 426 })),
    mcp: () => Promise.resolve(new Response('mcp')),
  });
}

/** An authorised JSON request to the chat world's app. */
export const chatRequest = async (
  world: ChatWorld,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
) =>
  await chatApp(world).request(path, {
    method,
    headers: { Authorization: `Bearer ${CHAT_APP_TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
