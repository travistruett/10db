import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { migrateDatabase, openDatabase } from '@10db/db';
import { createApp } from './api';
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

const app = createApp({ startedAt: new Date(), allowedOrigins: UI_ORIGINS });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: env.TENDB_PORT }, (info) => {
  console.log(`10db daemon listening on http://127.0.0.1:${String(info.port)} (data: ${dataDir})`);
});

const shutdown = (): void => {
  server.close();
  db.$client.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
