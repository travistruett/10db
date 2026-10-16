import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve, upgradeWebSocket, type WebSocketServerLike } from '@hono/node-server';
import { migrateDatabase, openDatabase } from '@10db/db';
import { WebSocketServer } from 'ws';
import { createApp, type ApiServices } from './api';
import { loadEnv } from './env';
import { resolveDataDir, resolveMigrationsDir } from './paths';

const UI_ORIGINS = [
  'http://localhost:1420',
  'tauri://localhost',
  'http://tauri.localhost',
] as const;

const env = loadEnv(process.env);
const dataDir = resolveDataDir(env);
mkdirSync(dataDir, { recursive: true });

const db = openDatabase(join(dataDir, '10db.sqlite'));
migrateDatabase(db, resolveMigrationsDir());

// Placeholders until the daemon composition replaces this file: only /health works in between.
const notWired = (): never => {
  throw new Error('The daemon services are not wired yet');
};
const placeholderServices: ApiServices = {
  listProjects: notWired,
  createProject: notWired,
  listTasks: notWired,
  createTask: notWired,
  startTask: notWired,
  listWorkstreams: notWired,
  cancelWorkstream: notWired,
  retryWorkstream: notWired,
  listInbox: notWired,
  answerInbox: notWired,
  eventsAfter: notWired,
  subscribe: notWired,
};
const app = createApp({
  startedAt: new Date(),
  allowedOrigins: UI_ORIGINS,
  token: randomBytes(32).toString('base64url'),
  services: placeholderServices,
  upgradeWebSocket,
  onUnexpectedError: (error) => {
    console.error('Unhandled API error', error);
  },
  mcp: () => Promise.resolve(Response.json({ error: 'not wired' }, { status: 503 })),
});
// The node server hands upgrade requests to this noServer socket server. The cast bridges ws's
// optional `options.noServer` to the node server's structural type, which requires a boolean.
const websocket = { server: new WebSocketServer({ noServer: true }) as WebSocketServerLike };
const server = serve(
  { fetch: app.fetch, hostname: '127.0.0.1', port: env.TENDB_PORT, websocket },
  (info) => {
    console.log(
      `10db daemon listening on http://127.0.0.1:${String(info.port)} (data: ${dataDir})`,
    );
  },
);

const shutdown = (): void => {
  server.close();
  db.$client.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
