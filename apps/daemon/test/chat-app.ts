import { defineWebSocketHelper } from 'hono/ws';
import { createApp } from '../src/api';
import { join } from 'node:path';
import { createChatApiServices, createChatChanges } from '../src/daemon';
import { createGit } from '../src/git';
import { silentLogger } from '../src/log';
import { createPendingOpens } from '../src/pass';
import { stubServices } from './api-stub';
import type { TitleRowGit } from '../src/chat';
import type { ChatWorld } from './chat-world';

/** A world whose title row has no git: its steps are refused. */
const NO_TITLE_ROW: TitleRowGit = {
  commit: () => Promise.reject(new Error('This world has no title-row git.')),
  openPullRequest: () => Promise.reject(new Error('This world has no title-row git.')),
};

/** The token the app under test accepts. */
export const CHAT_APP_TOKEN = 'ui-token-for-tests';

/** A chat world's own routes, served by the real app over its real services. */
export function chatApp(world: ChatWorld, extra: { readonly titleRow?: TitleRowGit } = {}) {
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
        titleRow: extra.titleRow ?? NO_TITLE_ROW,
        changes: createChatChanges({
          state: world.state,
          git: createGit({ worktreeRoot: join(world.dataDir, 'worktrees') }),
        }),
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
  extra: { readonly titleRow?: TitleRowGit } = {},
) =>
  await chatApp(world, extra).request(path, {
    method,
    headers: { Authorization: `Bearer ${CHAT_APP_TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
